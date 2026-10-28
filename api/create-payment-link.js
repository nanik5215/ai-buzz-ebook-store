
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const AMOUNT_PAISE = 7700;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  if (
    !RAZORPAY_KEY_ID ||
    !RAZORPAY_KEY_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(503).json({
      error: "Payment setup is incomplete."
    });
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

  let referenceId;

  try {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: "Please enter a valid email address."
      });
    }

    referenceId = crypto.randomUUID();

    const { error: insertError } = await supabase
      .from("orders")
      .insert({
        reference_id: referenceId,
        email,
        payment_status: "pending",
        delivery_status: "pending"
      });

    if (insertError) {
      console.error("Order creation failed:", insertError.message);
      return res.status(500).json({
        error: "Could not create your order."
      });
    }

    const response = await fetch(
      "https://api.razorpay.com/v1/payment_links",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: AMOUNT_PAISE,
          currency: "INR",
          accept_partial: false,
          reference_id: referenceId,
          description: "AI BUZZ eBook",
          customer: { email },
          notify: { email: false, sms: false },
          reminder_enable: false
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.id || !data.short_url) {
      console.error("Razorpay link creation failed:", {
        status: response.status,
        code: data.error?.code
      });

      await supabase
        .from("orders")
        .update({ delivery_error: "Payment link creation failed" })
        .eq("reference_id", referenceId);

      return res.status(502).json({
        error: "Could not start checkout. Please try again later."
      });
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({ payment_link_id: data.id })
      .eq("reference_id", referenceId);

    if (updateError) {
      console.error("Could not save payment link ID:", updateError.message);
      return res.status(500).json({
        error: "Could not finish creating your order."
      });
    }

    return res.status(200).json({
      paymentUrl: data.short_url
    });
  } catch (error) {
    console.error("Checkout error:", error.message);

    return res.status(502).json({
      error: "Checkout is temporarily unavailable."
    });
  }
}
