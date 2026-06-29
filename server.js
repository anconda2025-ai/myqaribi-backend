import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// CORS restrittivo — solo da app.myqaribi.com e myqaribi.com
app.use(cors({
  origin: [
    "https://app.myqaribi.com",
    "https://myqaribi.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// Rate limiting semplice (senza librerie esterne)
const rateLimit = new Map();
function checkRateLimit(ip, maxRequests = 20, windowMs = 60000) {
  const now = Date.now();
  const key = ip;
  const record = rateLimit.get(key) || { count: 0, start: now };
  if (now - record.start > windowMs) {
    rateLimit.set(key, { count: 1, start: now });
    return true;
  }
  if (record.count >= maxRequests) return false;
  record.count++;
  rateLimit.set(key, record);
  return true;
}

function rateLimitMiddleware(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Trop de requêtes — réessayez dans une minute" });
  }
  next();
}

app.use(rateLimitMiddleware);

const DAILY_LIMIT = 100;
const MIN_AMOUNT = 50;

// Crea sessione Stripe Checkout
app.post("/api/create-checkout", async (req, res) => {
  const { amount, recipient, currency, senderEmail } = req.body;
  const baseAmount = amount / 1.035;
  const commission = amount - baseAmount;
  const confirmationCode = Math.floor(1000 + Math.random() * 9000).toString();

  try {
    if (baseAmount < MIN_AMOUNT) {
      return res.status(400).json({ error: `Montant minimum : ${MIN_AMOUNT}€` });
    }

    if (senderEmail) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const { data: todayTx } = await supabase
        .from("transactions").select("amount")
        .eq("sender_email", senderEmail).neq("status", "problem")
        .gte("created_at", startOfDay.toISOString());

      const spentToday = (todayTx || []).reduce((s, t) => s + Number(t.amount), 0);
      if (spentToday + baseAmount > DAILY_LIMIT) {
        return res.status(400).json({ error: `Limite journalier dépassé. Il vous reste ${(DAILY_LIMIT - spentToday).toFixed(2)}€` });
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: currency || "eur",
          product_data: {
            name: `myQaribi — Transfert vers ${recipient}`,
            description: "Commission 3.5% incluse",
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: "https://app.myqaribi.com",
      cancel_url: "https://app.myqaribi.com",
      metadata: { recipient, app: "myqaribi", confirmation_code: confirmationCode, sender_email: senderEmail || "" },
    });

    const { error: dbError } = await supabase.from("transactions").insert({
      sender_name: senderEmail ? senderEmail.split("@")[0] : "Unknown",
      sender_email: senderEmail || null,
      recipient_name: recipient,
      amount: baseAmount,
      commission: commission,
      total: amount,
      status: "pending",
      confirmation_code: confirmationCode,
    });

    if (dbError) console.error("Errore salvataggio:", dbError);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook Stripe (bypass rate limit)
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Pagamento completato:", session.metadata.recipient, session.amount_total / 100, "€");
  }
  res.json({ received: true });
});

app.get("/api/pending-requests", async (req, res) => {
  const { data, error } = await supabase.from("transactions").select("*").eq("status", "pending").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/confirmed-today", async (req, res) => {
  const { data, error } = await supabase.from("transactions").select("*").eq("status", "confirmed").order("confirmed_at", { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/daily-limit", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email richiesta" });
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase.from("transactions").select("amount").eq("sender_email", email).neq("status", "problem").gte("created_at", startOfDay.toISOString());
  if (error) return res.status(500).json({ error: error.message });
  const spentToday = (data || []).reduce((sum, t) => sum + Number(t.amount), 0);
  res.json({ dailyLimit: DAILY_LIMIT, spentToday, remaining: Math.max(0, DAILY_LIMIT - spentToday) });
});

app.get("/api/admin/stats", async (req, res) => {
  const { data: transactions, error } = await supabase.from("transactions").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: merchants } = await supabase.from("merchants").select("*");
  const totalVolume = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const totalCommissions = transactions.reduce((s, t) => s + Number(t.commission), 0);
  res.json({ transactions, merchants, totalVolume, totalCommissions, transactionCount: transactions.length, merchantCount: merchants?.length || 0 });
});

app.post("/api/confirm-payment", async (req, res) => {
  const { id, code } = req.body;
  const { data, error } = await supabase.from("transactions").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", id).select();
  if (error) return res.status(500).json({ error: error.message });
  console.log(`✅ Pagamento confermato: codice #${code}`);
  res.json({ success: true, data });
});

app.post("/api/report-problem", async (req, res) => {
  const { id, code } = req.body;
  const { error } = await supabase.from("transactions").update({ status: "problem" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`⚠️ Problema segnalato: code #${code}`);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 myQaribi server su http://localhost:${PORT}`));
