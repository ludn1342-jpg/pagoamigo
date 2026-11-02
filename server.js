// ============================================================
//  server.js — RappiPay PSE (todo en uno)
// ============================================================

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const cors    = require('cors');
const path    = require('path');

const PORT = process.env.PORT || 3006;

// ── Configuración RappiPay ──────────────────────────────────
const RAPPIPAY_API       = 'https://services.prod-k8s.rappipay.com/integration/pse/api';
const RAPPIPAY_LINK_CODE = process.env.RAPPIPAY_LINK_CODE || 'x5BEvM';
const RAPPIPAY_FIREBASE  = {
  apiKey:      'AIzaSyBXJ_5dpN6uTDr41m72dcS_ZKJtGc_dVHw',
  authDomain:  'rpp-platform-mobile-app-prod.firebaseapp.com',
  databaseURL: 'https://rpp-platform-mobile-app-prod-default-rtdb.firebaseio.com',
  projectId:   'rpp-platform-mobile-app-prod',
  appId:       '1:507783753255:web:d3e9bdc53b9d31220ea802',
};

// ── Bancos Colombia (referencia) ────────────────────────────
const BANCOS_COLOMBIA = {
  "1007":"BANCOLOMBIA","1051":"DAVIVIENDA","1001":"BANCO DE BOGOTA","1013":"BBVA COLOMBIA",
  "1052":"BANCO AV VILLAS","1032":"BANCO CAJA SOCIAL","1023":"BANCO DE OCCIDENTE",
  "1002":"BANCO POPULAR","1019":"SCOTIABANK COLPATRIA","1062":"BANCO FALABELLA",
  "1012":"BANCO GNB SUDAMERIS","1014":"ITAU","1060":"BANCO PICHINCHA","1040":"BANCO AGRARIO",
  "1507":"NEQUI","1551":"DAVIPLATA","1070":"LULO BANK","1809":"NU COLOMBIA",
  "1811":"RAPPIPAY","1804":"UALA","1801":"MOVII","1009":"CITIBANK","1031":"BANCOLDEX",
  "1047":"BANCO MUNDO MUJER","1053":"BANCO W","1058":"BANCO PROCREDIT","1059":"BANCAMIA",
  "1061":"BANCOOMEVA","1063":"BANCO FINANDINA","1065":"BANCO SANTANDER","1066":"COOPCENTRAL",
  "1067":"MIBANCO","1069":"BANCO SERFINANZA","1071":"JP MORGAN","1097":"DALE",
  "1121":"JURISCOOP","1283":"CFA COOPERATIVA","1286":"JFK COOPERATIVA",
  "1289":"COTRAFA","1292":"CONFIAR","1303":"BANCO UNION","1370":"COLTEFINANCIERA",
  "1558":"BAN100","1560":"PIBANK","1637":"IRIS","1802":"DING TECNIPAGOS","1803":"POWWI",
  "1805":"BANCO BTG PACTUAL","1808":"BOLD CF","1812":"COINK","1814":"GLOBAL66",
  "1815":"ALIANZA FIDUCIARIA","1816":"CREZCAMOS","1819":"BANCO CONTACTAR"
};


// ============================================================
//  Obtener bancos PSE disponibles
// ============================================================
async function obtenerBancosRappiPay(code) {
  code = code || RAPPIPAY_LINK_CODE;
  const { data } = await axios.get(`${RAPPIPAY_API}/transfer-link/code/${code}`, {
    headers: { 'traceability-id': crypto.randomUUID() },
    timeout: 15_000,
  });
  return { transfer: data.transfer, banks: data.banks };
}


// ============================================================
//  Crear transacción PSE
//
//  Flujo:
//    a) GET /transfer-link/code/{code} → traceability_id
//    b) POST /payment-url              → custom token Firebase
//    c) Firebase signInWithCustomToken  → idToken
//    d) Firebase RTDB polling           → URL del banco PSE
// ============================================================
async function crearTransaccionPSE({ amount, bankCode, bankName, customerName, customerDoc, customerDocType, clientIp, linkCode }) {
  const code = linkCode || RAPPIPAY_LINK_CODE;

  // Paso A: Obtener info del transfer-link
  const { data: linkData } = await axios.get(`${RAPPIPAY_API}/transfer-link/code/${code}`, {
    headers: { 'traceability-id': crypto.randomUUID() },
    timeout: 15_000,
  });

  const traceabilityId = linkData.transfer.traceability_id;
  if (linkData.transfer.status !== 'CREATED') {
    throw new Error(`Link no disponible (status: ${linkData.transfer.status}).`);
  }

  const parsedAmount = parseInt(amount);
  if (parsedAmount < linkData.transfer.min_amount || parsedAmount > linkData.transfer.max_amount) {
    throw new Error(`Monto fuera de rango. Min: $${linkData.transfer.min_amount}, Max: $${linkData.transfer.max_amount}`);
  }

  const resolvedBankName = bankName
    || linkData.banks.find(b => b.code === bankCode)?.name
    || BANCOS_COLOMBIA[bankCode]
    || bankCode;

  // Paso B: POST /payment-url
  const payload = {
    traceability_id:      traceabilityId,
    bank_code:            bankCode,
    bank_name:            resolvedBankName,
    document_type:        customerDocType || 'CC',
    document_number:      customerDoc     || '',
    amount:               parsedAmount,
    user_agreement_check: true,
    client_ip:            clientIp,
  };

  const txRes = await axios.post(`${RAPPIPAY_API}/payment-url`, payload, {
    headers: { 'Content-Type': 'application/json', 'traceability-id': crypto.randomUUID() },
    timeout: 25_000,
  });

  const customToken = txRes.data?.token;
  const txTraceId   = txRes.data?.traceability_id || traceabilityId;

  if (!customToken) {
    const bankUrl = txRes.data?.redirectUrl || txRes.data?.url || txRes.data?.bankUrl || txRes.data?.payment_url || null;
    return { success: true, bankUrl, traceabilityId: txTraceId, rawResponse: txRes.data };
  }

  // Paso C: Firebase signInWithCustomToken
  const authRes = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${RAPPIPAY_FIREBASE.apiKey}`,
    { token: customToken, returnSecureToken: true },
    { timeout: 15_000 }
  );

  const idToken = authRes.data?.idToken;
  if (!idToken) throw new Error('Firebase signIn failed — no idToken');

  // Paso D: Firebase RTDB polling
  const dbPath = `cash_flow_cash_in_pse_link_transaction/${txTraceId}`;
  const dbUrls = [RAPPIPAY_FIREBASE.databaseURL, 'https://rpp-platform-mobile-app-prod.firebaseio.com'];

  let bankUrl = null, activeDbUrl = null;

  for (let attempt = 1; attempt <= 15; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 3000 : 2000));

    for (const dbBaseUrl of (activeDbUrl ? [activeDbUrl] : dbUrls)) {
      try {
        const dbRes = await axios.get(`${dbBaseUrl}/${dbPath}.json?auth=${idToken}`, { timeout: 10_000 });
        activeDbUrl = dbBaseUrl;
        if (dbRes.data?.params?.link) { bankUrl = dbRes.data.params.link; break; }
        break;
      } catch { /* probar otra URL */ }
    }
    if (bankUrl) break;
  }

  return { success: true, bankUrl, traceabilityId: txTraceId, rawResponse: txRes.data };
}


// ============================================================
//  Express — Endpoints
// ============================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Lista bancos PSE
app.get('/api/pasarela/rappipay-bancos', async (req, res) => {
  try {
    const data = await obtenerBancosRappiPay(req.query.code);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[RappiPay] Error bancos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Crear transacción PSE
app.post('/api/pasarela/rappipay-pse', async (req, res) => {
  try {
    const { amount, bankCode, bankName, customerName, customerDoc, customerDocType } = req.body;

    if (!amount || !bankCode)
      return res.status(400).json({ success: false, error: 'amount y bankCode son requeridos' });

    const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

    const result = await crearTransaccionPSE({
      amount, bankCode, bankName, customerName, customerDoc, customerDocType, clientIp,
    });

    res.json(result);
  } catch (err) {
    console.error('[RappiPay] Error PSE:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Archivos estáticos
app.use(express.static(path.join(__dirname)));

// Arrancar
app.listen(PORT, () => {
  console.log(`\n  RappiPay PSE corriendo en http://localhost:${PORT}\n`);
});
