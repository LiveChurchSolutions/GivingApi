import { controller, httpPost, interfaces } from "inversify-express-utils";
import express from "express";
import Stripe from "stripe";
import { GivingBaseController } from "./GivingBaseController"
import { StripeHelper } from "../helpers/StripeHelper";
import { EncryptionHelper } from "../apiBase/helpers";
import { Donation, FundDonation, DonationBatch, PaymentDetails, EventLog, Subscription, SubscriptionFund } from "../models";

@controller("/donate")
export class DonateController extends GivingBaseController {

    @httpPost("/log")
    public async log(req: express.Request<{}, {}, { donation: Donation, fundData: {id: string, amount: number} }>, res: express.Response): Promise<interfaces.IHttpActionResult> {
        return this.actionWrapperAnon(req, res, async () => {
            const secretKey = await this.loadPrivateKey(req.body.donation.churchId);
            const { donation, fundData } = req.body;
            if (secretKey === "") return this.json({}, 401);
            this.logDonation(donation, [fundData]);
        });
    }

    @httpPost("/webhook/:provider")
    public async init(req: express.Request<{}, {}, null>, res: express.Response): Promise<interfaces.IHttpActionResult> {
        return this.actionWrapperAnon(req, res, async () => {
            const churchId = req.query.churchId.toString();
            const gateways = await this.repositories.gateway.loadAll(churchId);
            if (!gateways.length) return this.json({}, 401);

            const gateway = gateways[0];
            const secretKey = EncryptionHelper.decrypt(gateway.privateKey);
            if (secretKey === "") return this.json({}, 401);

            // Verify webhook source
            const sig = req.headers["stripe-signature"].toString();
            const webhookKey = EncryptionHelper.decrypt(gateway.webhookKey);
            const stripeEvent: Stripe.Event = await StripeHelper.verifySignature(secretKey, req, sig, webhookKey);

            const eventData = stripeEvent.data.object as any; // https://github.com/stripe/stripe-node/issues/758

            // Ignore charge.succeeded from subscription events in place of invoice.paid for access to subscription id
            const subscriptionEvent = eventData.subscription || eventData.description?.toLowerCase().includes('subscription');
            if (stripeEvent.type === 'charge.succeeded' && subscriptionEvent) return this.json({}, 200);

            const { created, customer, status, amount, metadata, failure_message, outcome, payment_method_details } = eventData;
            const { amount_paid, subscription, billing_reason, charge } = eventData; // invoice.paid specific data

            let paymentMethodDetails = payment_method_details;
            if (charge) { // Get payment method info from charge data since it doesn't exist on invoice.paid
                const chargeData = await StripeHelper.getCharge(secretKey, charge);
                paymentMethodDetails = chargeData.payment_method_details;
            }

            // Extract payment details
            const methodTypes: any = { ach_debit: 'ACH Debit', card: 'Card' };
            const paymentType = paymentMethodDetails.type;
            const method = methodTypes[paymentType];
            const methodDetails = paymentMethodDetails[paymentType].last4;

            const donationDate = new Date(created * 1000); // Unix timestamp

            // Log event
            const existingEvent = await this.repositories.eventLog.load(churchId, stripeEvent.id);
            if (!existingEvent) {
                let message = billing_reason + ' ' + status;
                if (!billing_reason) message = failure_message ? failure_message + ' ' + outcome.seller_message : outcome.seller_message;
                const eventLog: EventLog = { id: stripeEvent.id, churchId, customerId: customer, provider: 'Stripe', eventType: stripeEvent.type, status, message, created: donationDate };
                await this.repositories.eventLog.create(eventLog)
            }

            // Log donation
            if (stripeEvent.type === 'charge.succeeded' || stripeEvent.type === 'invoice.paid') {
                const donationAmount = (amount || amount_paid) / 100;
                const customerData = await this.repositories.customer.load(churchId, customer);
                const donation: Donation = { amount: donationAmount, churchId, personId: customerData.personId, method, methodDetails, donationDate };
                const funds = metadata.funds ? JSON.parse(metadata.funds) : await this.repositories.subscriptionFund.loadBySubscriptionId(churchId, subscription);
                await this.logDonation(donation, funds);
            }
        });
    }

    @httpPost("/charge")
    public async charge(req: express.Request<any>, res: express.Response): Promise<interfaces.IHttpActionResult> {
        return this.actionWrapper(req, res, async (au) => {
            const secretKey = await this.loadPrivateKey(au.churchId);
            if (secretKey === "") return this.json({}, 401);
            const donationData = req.body;
            const fundDonations: FundDonation[] = donationData.funds;
            const paymentData: PaymentDetails = { amount: donationData.amount, currency: 'usd', customer: donationData.customerId, metadata: { funds: JSON.stringify(fundDonations) } };
            if (donationData.type === 'card') {
                paymentData.payment_method = donationData.id;
                paymentData.confirm = true;
                paymentData.off_session = true;
            }
            if (donationData.type === 'bank') paymentData.source = donationData.id;
            return await StripeHelper.donate(secretKey, paymentData);
        });
    }

    @httpPost("/subscribe")
    public async subscribe(req: express.Request<any>, res: express.Response): Promise<interfaces.IHttpActionResult> {
        return this.actionWrapper(req, res, async (au) => {
            const secretKey = await this.loadPrivateKey(au.churchId);
            if (secretKey === "") return this.json({}, 401);

            const { id, amount, customerId, type, billing_cycle_anchor, proration_behavior, interval, funds, person } = req.body;
            const paymentData: PaymentDetails = { payment_method_id: id, amount, currency: 'usd', customer: customerId, type, billing_cycle_anchor, proration_behavior, interval };
            const gateways = await this.repositories.gateway.loadAll(au.churchId);
            paymentData.productId = gateways[0].productId;

            const stripeSubscription = await StripeHelper.createSubscription(secretKey, paymentData);
            const subscription: Subscription = { id: stripeSubscription.id, churchId: au.churchId, personId: person.id, customerId };
            await this.repositories.subscription.save(subscription);

            const promises: Promise<SubscriptionFund>[] = [];
            funds.forEach((fund: FundDonation) => {
                const subscriptionFund: SubscriptionFund = { churchId: au.churchId, subscriptionId: subscription.id, fundId: fund.id, amount: fund.amount };
                promises.push(this.repositories.subscriptionFund.save(subscriptionFund));
            });
            return await Promise.all(promises);
        });
    }

    private logDonation = async (donationData: Donation, fundData: FundDonation[]) => {
        const batch: DonationBatch = await this.repositories.donationBatch.getOrCreateCurrent(donationData.churchId);
        donationData.batchId = batch.id;
        const donation = await this.repositories.donation.save(donationData);
        const promises: Promise<FundDonation>[] = [];
        fundData.forEach((fund: FundDonation) => {
            const fundDonation: FundDonation = { churchId: donation.churchId, amount: fund.amount, donationId: donation.id, fundId: fund.id };
            promises.push(this.repositories.fundDonation.save(fundDonation));
        });
        return await Promise.all(promises);
    }

    private loadPrivateKey = async (churchId: string) => {
        const gateways = await this.repositories.gateway.loadAll(churchId);
        return (gateways.length === 0) ? "" : EncryptionHelper.decrypt(gateways[0].privateKey);
    }

}
