// api/submit.js — Vercel Serverless Function
// Your Airtable token lives HERE on the server, never in the browser

const PROJECT_TABLES = {
  SPN004: 'test',
  SPN062: 'spn001',
  SBN003: 'spn015',
SPN003: "Spn003",
 NG008: "NG008",
  NG014: "NG014",
  SBN025: "SBN025",
SBN005: "SBN005",
SBN002: "SBN002",
SBN022: "SBN022",
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const { project, fields } = req.body;

  if (!project || !PROJECT_TABLES[project]) {
    return res.status(400).json({ error: 'Invalid project number' });
  }

  const table = PROJECT_TABLES[project];

  try {
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    );

    const data = await airtableRes.json();

    if (!airtableRes.ok) {
      return res.status(airtableRes.status).json({ error: data.error?.message || 'Airtable error' });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
