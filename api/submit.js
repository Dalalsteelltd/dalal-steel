const PROJECT_TABLES = {
  SPN004: "test",
  SPN062: "spn001",
  SBN003: "spn015",
  SPN003: "Spn003"
};

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  var AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  var project = req.body.project;
  var fields = req.body.fields;

  if (!project || !PROJECT_TABLES[project]) {
    return res.status(400).json({ error: "Invalid project number" });
  }

  var table = PROJECT_TABLES[project];
  var url = "https://api.airtable.com/v0/" + AIRTABLE_BASE_ID + "/" + encodeURIComponent(table);

  try {
    var response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + AIRTABLE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: fields })
    });

    var data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error ? data.error.message : "Airtable error" });
    }

    return res.status(200).json({ success: true, id: data.id });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
