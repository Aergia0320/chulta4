// Vercel Serverless Function: Google Calendar (.ics) Sync & Discord Webhook Bridge

// File path in GitHub repo: api/sync.js





function pad2(n) {

  return String(n).padStart(2, "0");

}





function toYMD(y, m, d) {

  return `${y}-${pad2(m)}-${pad2(d)}`;

}





function shiftYMD(ymd, deltaDays) {

  const [y, m, d] = ymd.split("-").map(Number);

  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));

  return toYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

}



function unescapeICS(val) {

  return String(val || "")

    .replace(/\\n/gi, "\n")

    .replace(/\\,/g, ",")

    .replace(/\\;/g, ";")

    .replace(/\\\\/g, "\\")

    .trim();

}





function parseICSDate(rawParam, rawVal) {

  const val = String(rawVal || "").trim();

  const isDateOnly = /VALUE=DATE/i.test(rawParam || "") || /^\d{8}$/.test(val);





  if (isDateOnly) {

    const m = val.match(/^(\d{4})(\d{2})(\d{2})/);

    if (!m) return null;

    return { ymd: toYMD(Number(m[1]), Number(m[2]), Number(m[3])), time: "", allDay: true };

  }
