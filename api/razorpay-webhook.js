
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
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
    SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY,
    DELIVERY_FROM_EMAIL
  } = process.env;

  if (
    !RAZORPAY_WEBHOOK_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !RESEND_API_KEY ||
    !DELIVERY_FROM_EMAIL
  ) {
    return res.status(500).send("Configuration missing");
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
      return res.status(400).send("Payment details missing");
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
      .select("reference_id, email, payment_link_id, payment_status")
      .eq("reference_id", link.reference_id)
      .maybeSingle();

    if (lookupError) {
      console.error("Order lookup failed:", lookupError.message);
      return res.status(500).send("Order lookup failed");
    }

    if (!order || order.payment_link_id !== link.id) {
      return res.status(400).send("Order does not match");
    }

    if (order.payment_status !== "paid") {
      const { error: paymentError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          payment_id: payment.id,
          paid_at: new Date().toISOString()
        })
        .eq("reference_id", link.reference_id)
        .eq("payment_link_id", link.id)
        .eq("payment_status", "pending");

      if (paymentError) {
        console.error("Payment update failed:", paymentError.message);
        return res.status(500).send("Payment update failed");
      }
    }

    const { data: claimedOrder, error: claimError } = await supabase
      .from("orders")
      .update({ delivery_status: "sending", delivery_error: null })
      .eq("reference_id", link.reference_id)
      .eq("payment_status", "paid")
      .in("delivery_status", ["pending", "failed"])
      .select("email")
      .maybeSingle();

    if (claimError) {
      console.error("Delivery claim failed:", claimError.message);
      return res.status(500).send("Delivery claim failed");
    }

    if (!claimedOrder) {
      return res.status(200).send("Already processed or in progress");
    }

    try {
      const { data: file, error: fileError } = await supabase
        .storage
        .from("ebooks")
        .createSignedUrl(
          "AI_BUZZ_Video_Creation_Guide.pdf",
          86400
        );

      if (fileError || !file?.signedUrl) {
        throw new Error("Could not create download link");
      }

      const resend = new Resend(RESEND_API_KEY);

      const { error: emailError } = await resend.emails.send({
        from: DELIVERY_FROM_EMAIL,
        to: claimedOrder.email,
        subject: "Your AI BUZZ eBook is ready!",
        html: `
          <h2>Thank you for purchasing AI BUZZ!</h2>
          <p>Your payment has been verified.</p>
          <p>Click below to download your eBook:</p>
          <p>
            <a href="${file.signedUrl}">
              Download AI BUZZ Video Creation Guide
            </a>
          </p>
          <p>This download link expires in 24 hours.</p>
        `
      });

      if (emailError) {
        throw new Error(emailError.message);
      }

      const { error: sentError } = await supabase
        .from("orders")
        .update({ delivery_status: "sent" })
        .eq("reference_id", link.reference_id)
        .eq("delivery_status", "sending");

      if (sentError) {
        console.error("Delivery status update failed:", sentError.message);
        return res.status(500).send("Delivery status update failed");
      }

      return res.status(200).send("Payment verified and email sent");
    } catch (deliveryError) {
      console.error("Email delivery failed:", deliveryError.message);

      await supabase
        .from("orders")
        .update({
          delivery_status: "failed",
          delivery_error: String(deliveryError.message).slice(0, 500)
        })
        .eq("reference_id", link.reference_id)
        .eq("delivery_status", "sending");

      return res.status(500).send("Email delivery failed");
    }
  } catch (error) {
    console.error("Webhook processing failed:", error.message);
    return res.status(500).send("Webhook processing failed");
  }
}
