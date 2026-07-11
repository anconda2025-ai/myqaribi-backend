import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors({
  origin: ["https://app.myqaribi.com", "https://myqaribi.com", "http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

const rateLimit = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, start: now };
  if (now - record.start > 60000) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (record.count >= 20) return false;
  record.count++; rateLimit.set(ip, record); return true;
}
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Trop de requêtes" });
  next();
});

const DAILY_LIMIT = 100;
const MIN_AMOUNT = 50;

function getFeeRate(amount) {
  if (amount >= 200) return 0.055;
  if (amount >= 150) return 0.06;
  if (amount >= 100) return 0.07;
  return 0.08;
}

app.post("/api/create-checkout", async (req, res) => {
  const { amount, recipient, currency, senderEmail, feeRate, merchantId, merchantName, documentUrl } = req.body;
  const rate = feeRate || getFeeRate(amount / 1.08);
  const baseAmount = amount / (1 + rate);
  const commission = amount - baseAmount;
  const confirmationCode = Math.floor(1000 + Math.random() * 9000).toString();
  try {
    if (baseAmount < MIN_AMOUNT) return res.status(400).json({ error: `Montant minimum : ${MIN_AMOUNT}€` });
    if (senderEmail) {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const { data: todayTx } = await supabase.from("transactions").select("amount").eq("sender_email", senderEmail).neq("status", "problem").gte("created_at", startOfDay.toISOString());
      const spentToday = (todayTx || []).reduce((s, t) => s + Number(t.amount), 0);
      if (spentToday + baseAmount > DAILY_LIMIT) return res.status(400).json({ error: `Limite journalier dépassé. Il vous reste ${(DAILY_LIMIT - spentToday).toFixed(2)}€` });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: currency || "eur", product_data: { name: `myQaribi — Transfert vers ${recipient}`, description: `Commission ${Math.round(rate * 100)}% incluse` }, unit_amount: Math.round(amount * 100) }, quantity: 1 }],
      mode: "payment",
      success_url: "https://app.myqaribi.com",
      cancel_url: "https://app.myqaribi.com",
      metadata: { recipient, app: "myqaribi", confirmation_code: confirmationCode, sender_email: senderEmail || "" },
    });
    await supabase.from("transactions").insert({ sender_name: senderEmail ? senderEmail.split("@")[0] : "Unknown", sender_email: senderEmail || null, recipient_name: recipient, amount: baseAmount, commission, total: amount, status: "pending", confirmation_code: confirmationCode, archived: false, merchant_id: merchantId || null, document_url: documentUrl || null });
    res.json({ id: session.id, url: session.url });
  } catch (error) { console.error("Stripe error:", error); res.status(500).json({ error: error.message }); }
});

app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || ""); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === "checkout.session.completed") console.log("✅ Pagamento:", event.data.object.metadata.recipient);
  res.json({ received: true });
});

app.get("/api/pending-requests", async (req, res) => {
  const { data, error } = await supabase.from("transactions").select("*").eq("status", "pending").eq("archived", false).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/confirmed-today", async (req, res) => {
  const { data, error } = await supabase.from("transactions").select("*").eq("status", "confirmed").eq("archived", false).order("confirmed_at", { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/daily-limit", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email richiesta" });
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase.from("transactions").select("amount").eq("sender_email", email).neq("status", "problem").gte("created_at", startOfDay.toISOString());
  if (error) return res.status(500).json({ error: error.message });
  const spentToday = (data || []).reduce((sum, t) => sum + Number(t.amount), 0);
  res.json({ dailyLimit: DAILY_LIMIT, spentToday, remaining: Math.max(0, DAILY_LIMIT - spentToday) });
});

app.get("/api/admin/stats", async (req, res) => {
  const { data: transactions, error } = await supabase.from("transactions").select("*").eq("archived", false).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: merchants } = await supabase.from("merchants").select("*");
  const totalVolume = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const totalCommissions = transactions.reduce((s, t) => s + Number(t.commission), 0);
  res.json({ transactions, merchants, totalVolume, totalCommissions, transactionCount: transactions.length, merchantCount: merchants?.length || 0 });
});

app.get("/api/admin/archive", async (req, res) => {
  const { data: transactions, error } = await supabase.from("transactions").select("*").eq("archived", true).order("archived_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const totalVolume = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const totalCommissions = transactions.reduce((s, t) => s + Number(t.commission), 0);
  res.json({ transactions, totalVolume, totalCommissions, transactionCount: transactions.length });
});

app.post("/api/archive-transaction", async (req, res) => {
  const { id } = req.body;
  const { error } = await supabase.from("transactions").update({ archived: true, archived_at: new Date().toISOString() }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/api/archive-confirmed", async (req, res) => {
  const { error } = await supabase.from("transactions").update({ archived: true, archived_at: new Date().toISOString() }).eq("status", "confirmed").eq("archived", false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/api/confirm-payment", async (req, res) => {
  const { id, code } = req.body;
  const { data, error } = await supabase.from("transactions").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", id).select();
  if (error) return res.status(500).json({ error: error.message });
  console.log(`✅ Confermato: #${code}`);
  res.json({ success: true, data });
});

app.post("/api/report-problem", async (req, res) => {
  const { id, code } = req.body;
  const { error } = await supabase.from("transactions").update({ status: "problem" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`⚠️ Problema: #${code}`);
  res.json({ success: true });
});

// Chat proxy endpoint — evita CORS sulla landing page
app.post("/api/chat", async (req, res) => {
  const { messages, lang } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages requis" });

  const systemPrompts = {
    fr: "Tu es l'assistant virtuel de myQaribi, une application de transfert d'argent permettant d'envoyer de l'argent à des proches dans des zones rurales et villages. Réponds en français, de manière courte et claire (2-3 phrases max). Commission: 8% pour 50-99€, 7% pour 100€. Min: 50€, Max: 100€/jour. Le commerçant local remet l'argent en espèces. Paiement sécurisé par carte. Phase bêta sur invitation. Contact: contact@myqaribi.com",
    en: "You are the myQaribi virtual assistant, a money transfer app to send money to relatives in rural villages. Reply in English, short and clear (2-3 sentences max). Commission: 8% for 50-99€, 7% for 100€. Min: 50€, Max: 100€/day. Local merchant pays cash. Secure card payment. Beta phase by invitation. Contact: contact@myqaribi.com",
    it: "Sei l'assistente virtuale di myQaribi, un'app di trasferimento denaro verso villaggi rurali. Rispondi in italiano, breve e chiaro (2-3 frasi max). Commissione: 8% per 50-99€, 7% per 100€. Min: 50€, Max: 100€/giorno. Il negoziante locale paga in contanti. Pagamento sicuro con carta. Fase beta su invito. Contatto: contact@myqaribi.com",
    ar: "أنت المساعد الافتراضي لـ myQaribi، تطبيق تحويل الأموال إلى القرى النائية. أجب بالعربية، بإيجاز (2-3 جمل). العمولة: 8% لـ 50-99€، 7% لـ 100€. الحد الأدنى 50€، الأقصى 100€/يوم. التاجر المحلي يدفع نقداً. دفع آمن بالبطاقة. مرحلة تجريبية بدعوة. التواصل: contact@myqaribi.com"
  };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompts[lang] || systemPrompts.fr,
        messages: messages.slice(-6)
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || "Contactez contact@myqaribi.com";
    res.json({ reply });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 myQaribi server su http://localhost:${PORT}`));
