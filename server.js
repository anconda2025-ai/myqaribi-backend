import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

// Crea sessione Stripe Checkout
app.post("/api/create-checkout", async (req, res) => {
  const { amount, recipient, currency } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: currency || "eur",
            product_data: {
              name: `myQaribi — Transfert vers ${recipient}`,
              description: "Commissione 2% inclusa",
            },
            unit_amount: Math.round(amount * 100), // centesimi
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "http://localhost:5173/success",
      cancel_url: "http://localhost:5173/",
      metadata: {
        recipient,
        app: "myqaribi",
      },
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook Stripe (per confermare pagamento)
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Pagamento completato:", session.metadata.recipient, session.amount_total / 100, "€");
    // TODO: notifica negoziante via Wise
  }

  res.json({ received: true });
});

// Conferma pagamento cash da parte del negoziante
const confirmedPayments = []; // TODO: sostituire con database reale

app.post("/api/confirm-payment", (req, res) => {
  const { id, name, code, amount } = req.body;

  confirmedPayments.push({
    id,
    name,
    code,
    amount,
    confirmedAt: new Date().toISOString(),
  });

  console.log(`✅ Pagamento confermato: ${name} — ${amount}€ — code #${code}`);

  // TODO: notifica cliente, aggiorna stato transazione, attiva rimborso serale negoziante
  res.json({ success: true });
});

// Segnala un problema
app.post("/api/report-problem", (req, res) => {
  const { id, name, code } = req.body;
  console.log(`⚠️ Problema segnalato: ${name} — code #${code}`);
  // TODO: notifica admin
  res.json({ success: true });
});


app.listen(PORT, () => {
  console.log(`🚀 myQaribi server su http://localhost:${PORT}`);
});
