

import crypto from "node:crypto";

const AMOUNT_PAISE = 7700;
const CURRENCY = "INR";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.status(503).json({
      error: "Payment setup is incomplete. Please try again later."
    });
  }

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

    const referenceId = crypto.randomUUID();

    const response = await fetch(
      "https://api.razorpay.com/v1/payment_links",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: AMOUNT_PAISE,
          currency: CURRENCY,
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

    if (!response.ok || !data.short_url) {
      console.error("Razorpay link creation failed:", {
        status: response.status,
        code: data.error?.code
      });

      return res.status(502).json({
        error: "Could not start checkout. Please try again later."
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
