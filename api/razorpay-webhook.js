
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const {
    RAZORPAY_WEBHOOK_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  if (
    !RAZORPAY_WEBHOOK_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(500).send("Webhook configuration missing");
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["x-razorpay-signature"];

    if (
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      return res.status(400).send("Invalid signature");
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const received = Buffer.from(signature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.status(400).send("Signature verification failed");
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.event !== "payment_link.paid") {
      return res.status(200).send("Event ignored");
    }

    const link = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;

    if (!link?.id || !link?.reference_id || !payment?.id) {
      return res.status(400).send("Missing payment details");
    }

    if (
      link.status !== "paid" ||
      link.amount !== 7700 ||
      link.amount_paid !== 7700 ||
      link.currency !== "INR" ||
      payment.status !== "captured" ||
      payment.amount !== 7700 ||
      payment.currency !== "INR"
    ) {
      return res.status(400).send("Payment validation failed");
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { data: order, error: lookupError } = await supabase
      .from("orders")
      .select("reference_id, payment_link_id, payment_status")
      .eq("reference_id", link.reference_id)
      .maybeSingle();

    if (lookupError) {
      console.error("Order lookup failed:", lookupError.message);
      return res.status(500).send("Order lookup failed");
    }

    if (!order || order.payment_link_id !== link.id) {
      return res.status(400).send("Order does not match payment");
    }

    if (order.payment_status === "paid") {
      return res.status(200).send("Already processed");
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        payment_id: payment.id,
        paid_at: new Date().toISOString()
      })
      .eq("reference_id", link.reference_id)
      .eq("payment_link_id", link.id)
      .eq("payment_status", "pending");

    if (updateError) {
      console.error("Order update failed:", updateError.message);
      return res.status(500).send("Could not update order");
    }

    return res.status(200).send("Payment verified");
  } catch (error) {
    console.error("Webhook processing failed:", error.message);
    return res.status(500).send("Webhook processing failed");
  }
}
