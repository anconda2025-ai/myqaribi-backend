import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.json());

// Crea sessione Stripe Checkout
app.post("/api/create-checkout", async (req, res) => {
  const { amount, recipient, currency, senderEmail } = req.body;
  const baseAmount = amount / 1.02; // amount already includes 2% commission
  const commission = amount - baseAmount;
  const confirmationCode = Math.floor(1000 + Math.random() * 9000).toString();

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
        confirmation_code: confirmationCode,
        sender_email: senderEmail || "",
      },
    });

    // Salva la transazione come "pending" nel database
    const { error: dbError } = await supabase.from("transactions").insert({
      sender_name: senderEmail ? senderEmail.split("@")[0] : "Ahmed K.",
      sender_email: senderEmail || null,
      recipient_name: recipient,
      amount: baseAmount,
      commission: commission,
      total: amount,
      status: "pending",
      confirmation_code: confirmationCode,
    });

    if (dbError) console.error("Errore salvataggio transazione:", dbError);

    res.json({ id: session.id, url: session.url });
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
  }

  res.json({ received: true });
});

// Lista richieste in attesa (per app negoziante)
app.get("/api/pending-requests", async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Lista richieste confermate oggi (per app negoziante)
app.get("/api/confirmed-today", async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Limite giornaliero reale per utente (basato sulle transazioni di oggi)
app.get("/api/daily-limit", async (req, res) => {
  const { email } = req.query;
  const DAILY_LIMIT = 50;

  if (!email) return res.status(400).json({ error: "email richiesta" });

  const senderName = email.split("@")[0];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("transactions")
    .select("amount")
    .eq("sender_email", email)
    .neq("status", "problem")
    .gte("created_at", startOfDay.toISOString());

  if (error) return res.status(500).json({ error: error.message });

  const spentToday = (data || []).reduce((sum, t) => sum + Number(t.amount), 0);
  const remaining = Math.max(0, DAILY_LIMIT - spentToday);

  res.json({ dailyLimit: DAILY_LIMIT, spentToday, remaining });
});

// Statistiche per dashboard admin
app.get("/api/admin/stats", async (req, res) => {
  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: merchants } = await supabase.from("merchants").select("*");

  const totalVolume = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const totalCommissions = transactions.reduce((s, t) => s + Number(t.commission), 0);

  res.json({
    transactions,
    merchants,
    totalVolume,
    totalCommissions,
    transactionCount: transactions.length,
    merchantCount: merchants?.length || 0,
  });
});

// Conferma pagamento cash da parte del negoziante
app.post("/api/confirm-payment", async (req, res) => {
  const { id, code } = req.body;

  const { data, error } = await supabase
    .from("transactions")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .select();

  if (error) {
    console.error("Errore conferma pagamento:", error);
    return res.status(500).json({ error: error.message });
  }

  console.log(`✅ Pagamento confermato: codice #${code}`);
  res.json({ success: true, data });
});

// Segnala un problema
app.post("/api/report-problem", async (req, res) => {
  const { id, code } = req.body;

  const { error } = await supabase
    .from("transactions")
    .update({ status: "problem" })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  console.log(`⚠️ Problema segnalato: code #${code}`);
  res.json({ success: true });
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 myQaribi server su http://localhost:${PORT}`);
});
