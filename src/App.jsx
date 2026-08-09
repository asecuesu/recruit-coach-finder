import { useState, useEffect, useRef, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
// Coach Finder — a recruiting tool for HS / transfer track & field
// athletes. Find college coaches + their emails, then fire off a
// personalized intro email in one tap.
//
// Reuses the existing Cloudflare Worker (holds the Gemini API key
// server-side). GitHub Pages serves this from the same
// asecuesu.github.io origin, so the worker's CORS allowlist already
// covers it — no worker change needed.
// ═══════════════════════════════════════════════════════════════

const BUILD_VERSION = "2026-08-09-v7";
const PROXY_URL = "https://divine-dust-7329.andrei-secuesu.workers.dev";

// ── Theme ──────────────────────────────────────────────────────
const T = {
  bg: "#f4f7f6",
  accent: "#0f766e",
  accentDark: "#0b5850",
  accentSoft: "#e2f1ee",
  ink: "#1a2b2b",
  sub: "#5c6f6c",
  faint: "#8a9a97",
  line: "#e3eae8",
  card: "#ffffff",
  danger: "#c0392b",
  gold: "#d69e2e",
};

// ── Worker calls (reused, proven logic from the dashboard) ─────
async function geminiSearch(prompt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
    } catch {
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status)) {
      await new Promise(r => setTimeout(r, (res.status === 429 ? 20000 : 6000) * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Search service error ${res.status}: ${errText.slice(0, 160)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || "").join(" ").trim();
  }
  throw new Error("Search service is busy right now — please try again in a moment.");
}

function extractJson(text) {
  const clean = text.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
  const objMatches = clean.match(/\{[\s\S]*\}/g);
  if (objMatches) {
    const longest = objMatches.reduce((a, b) => (a.length >= b.length ? a : b));
    try { return JSON.parse(longest); } catch { /* fall through */ }
  }
  const arrMatches = clean.match(/\[[\s\S]*\]/g);
  if (arrMatches) {
    const longest = arrMatches.reduce((a, b) => (a.length >= b.length ? a : b));
    try { return JSON.parse(longest); } catch { /* fall through */ }
  }
  return null;
}

function extractJsonArray(text) {
  const clean = text.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
  const matches = clean.match(/\[[\s\S]*\]/g);
  if (!matches) return [];
  const longest = matches.reduce((a, b) => (a.length >= b.length ? a : b));
  try { return JSON.parse(longest); } catch { return []; }
}

async function fetchPageRows(url) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "fetchPage", url }),
  });
  if (!res.ok) throw new Error(`Page fetch ${res.status}`);
  const data = await res.json();
  return data.rows || [];
}

// ── localStorage-backed state ──────────────────────────────────
function useStored(key, initial) {
  const [val, setVal] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota */ }
  }, [key, val]);
  return [val, setVal];
}

const EMPTY_PROFILE = {
  firstName: "", lastName: "", gradYear: "", teamGender: "Women's",
  sport: "", // no assumed sport — the athlete picks their own
  events: "", prs: "", gpa: "", highSchool: "", location: "",
  clubTeam: "", videoUrl: "", phone: "", email: "",
};

// NCAA-sponsored sports (championship + emerging) for the picker's suggestions.
// The field is free text, so anything not listed can still be typed.
const SPORTS = [
  "Acrobatics & Tumbling", "Baseball", "Basketball", "Beach Volleyball", "Bowling",
  "Cross Country", "Equestrian", "Fencing", "Field Hockey", "Football", "Golf",
  "Gymnastics", "Ice Hockey", "Lacrosse", "Rifle", "Rowing", "Rugby", "Sailing",
  "Skiing", "Soccer", "Softball", "Squash", "Swimming & Diving", "Tennis",
  "Track & Field", "Triathlon", "Volleyball", "Water Polo", "Wrestling",
];

// Sensible default gender for single-gender NCAA sports (helpful, not a hard lock —
// the athlete can still switch, since some of these have emerging programs).
function defaultGenderFor(sport) {
  const s = (sport || "").toLowerCase();
  if (/softball|field hockey|beach volleyball/.test(s)) return "Women's";
  if (s === "baseball" || s === "football") return "Men's";
  return null;
}

// A coach's identity key (dedupe + saved lookups)
const coachKey = c => `${(c.School || "").toLowerCase()}|${(c.Gender || "").toLowerCase()}|${(c.Name || "").toLowerCase()}`;
const lastName = full => (full || "").trim().split(/\s+/).pop() || "";

// ── Email draft builder ────────────────────────────────────────
function buildEmail(profile, coach) {
  const p = profile;
  const sport = (p.sport || "").trim();
  const sportLower = sport.toLowerCase();
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "[Your name]";
  const coachLast = lastName(coach.Name) || "Coach";
  const grad = p.gradYear ? `Class of ${p.gradYear}` : "prospective student-athlete";
  const teamWord = (coach.Gender || p.teamGender || "").toString().toLowerCase();

  const subject = `${p.events ? p.events + " " : ""}${sport ? sport + " " : ""}Recruit — ${grad}${p.firstName || p.lastName ? " — " + name : ""}`.trim();

  const lines = [];
  lines.push(`Dear Coach ${coachLast},`);
  lines.push("");
  const intro = `My name is ${name} and I'm a ${grad}${p.highSchool ? ` at ${p.highSchool}` : ""}${p.location ? ` in ${p.location}` : ""}. I'm very interested in ${coach.School}'s ${teamWord ? teamWord + " " : ""}${sport ? sportLower + " " : ""}program and would love to be considered for your recruiting class.`;
  lines.push(intro);
  lines.push("");
  const stats = [];
  if (p.events) stats.push(`Events / position: ${p.events}`);
  if (p.prs) stats.push(`Personal bests: ${p.prs}`);
  if (p.gpa) stats.push(`GPA: ${p.gpa}`);
  if (p.clubTeam) stats.push(`Club/Team: ${p.clubTeam}`);
  if (stats.length) {
    lines.push("A quick snapshot of where I'm at:");
    stats.forEach(s => lines.push(`  • ${s}`));
    lines.push("");
  }
  if (p.videoUrl) {
    lines.push(`You can see my results and highlight video here: ${p.videoUrl}`);
    lines.push("");
  }
  lines.push(`I'd welcome the chance to talk about how I could contribute to your program. Thank you for your time and consideration — I hope to hear from you.`);
  lines.push("");
  lines.push("Best regards,");
  lines.push(name);
  const contact = [p.email, p.phone].filter(Boolean).join(" · ");
  if (contact) lines.push(contact);

  return { subject, body: lines.join("\n") };
}

function mailtoLink(coach, subject, body) {
  const to = coach.Email || "";
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ── Small UI atoms ─────────────────────────────────────────────
function Spinner({ size = 16, color = "#fff" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: `2px solid ${color}`, borderTopColor: "transparent",
      borderRadius: "50%", animation: "spin 0.7s linear infinite", verticalAlign: "middle",
    }} />
  );
}

function Field({ label, hint, ...props }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>
        {label} {hint && <span style={{ color: T.faint, fontWeight: 400 }}>· {hint}</span>}
      </div>
      <input {...props} style={{
        width: "100%", padding: "11px 13px", borderRadius: 10, border: `1px solid ${T.line}`,
        fontSize: 15, background: "#fbfdfc", outline: "none", color: T.ink,
      }} />
    </label>
  );
}

const PrimaryBtn = ({ children, disabled, style, ...p }) => (
  <button disabled={disabled} {...p} style={{
    padding: "12px 20px", borderRadius: 12, border: "none",
    background: disabled ? "#cbd5d3" : T.accent, color: "#fff",
    fontSize: 15, fontWeight: 700, cursor: disabled ? "default" : "pointer",
    display: "inline-flex", alignItems: "center", gap: 8, ...style,
  }}>{children}</button>
);

const GhostBtn = ({ children, style, active, ...p }) => (
  <button {...p} style={{
    padding: "9px 15px", borderRadius: 10,
    border: `1px solid ${active ? T.accent : T.line}`,
    background: active ? T.accentSoft : "#fff",
    color: active ? T.accentDark : T.sub,
    fontSize: 14, fontWeight: 600, cursor: "pointer", ...style,
  }}>{children}</button>
);

// ═══════════════════════════════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════════════════════════════
function ProfileTab({ profile, setProfile }) {
  const set = (k, v) => setProfile(p => ({ ...p, [k]: v }));
  const complete = profile.firstName && profile.lastName && profile.gradYear && profile.email;
  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "8px 4px" }}>
      <div style={{ background: T.accentSoft, borderRadius: 14, padding: "16px 18px", marginBottom: 22, color: T.accentDark, fontSize: 14, lineHeight: 1.5 }}>
        <b>Fill this out once.</b> Everything here auto-fills your intro emails to coaches, so you never re-type your stats. It's saved on this device only — nothing is uploaded.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Field label="First name" value={profile.firstName} onChange={e => set("firstName", e.target.value)} placeholder="Jordan" />
        <Field label="Last name" value={profile.lastName} onChange={e => set("lastName", e.target.value)} placeholder="Rivera" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>My sport</div>
        <input list="rcf-sports" value={profile.sport || ""}
          onChange={e => { const v = e.target.value; const dg = defaultGenderFor(v); setProfile(p => ({ ...p, sport: v, ...(dg ? { teamGender: dg } : {}) })); }}
          placeholder="Start typing… e.g. Soccer, Rowing, Track & Field"
          style={{ width: "100%", padding: "11px 13px", borderRadius: 10, border: `1px solid ${T.line}`, fontSize: 15, background: "#fbfdfc", outline: "none", color: T.ink }} />
        <datalist id="rcf-sports">{SPORTS.map(s => <option key={s} value={s} />)}</datalist>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Field label="Graduation year" hint="class of" value={profile.gradYear} onChange={e => set("gradYear", e.target.value)} placeholder="2027" inputMode="numeric" />
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>I compete on the</div>
          <div style={{ display: "flex", gap: 8 }}>
            {["Women's", "Men's"].map(g => (
              <GhostBtn key={g} active={profile.teamGender === g} onClick={() => set("teamGender", g)} style={{ flex: 1 }}>{g} team</GhostBtn>
            ))}
          </div>
        </div>
      </div>

      <Field label="Events / position" hint="what you'd be recruited for" value={profile.events} onChange={e => set("events", e.target.value)} placeholder="Long Jump, 100m — or: Midfielder, Coxswain…" />
      <Field label="Personal bests" value={profile.prs} onChange={e => set("prs", e.target.value)} placeholder="LJ 6.10m, 100m 11.8" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Field label="GPA" value={profile.gpa} onChange={e => set("gpa", e.target.value)} placeholder="3.8" />
        <Field label="High school" value={profile.highSchool} onChange={e => set("highSchool", e.target.value)} placeholder="Lincoln HS" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Field label="Location" hint="city, state" value={profile.location} onChange={e => set("location", e.target.value)} placeholder="Austin, TX" />
        <Field label="Club / team" hint="optional" value={profile.clubTeam} onChange={e => set("clubTeam", e.target.value)} placeholder="Austin Elite TC" />
      </div>

      <Field label="Video / results link" hint="athletic.net, Hudl, YouTube…" value={profile.videoUrl} onChange={e => set("videoUrl", e.target.value)} placeholder="https://athletic.net/..." />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
        <Field label="Your email" value={profile.email} onChange={e => set("email", e.target.value)} placeholder="jordan@email.com" type="email" />
        <Field label="Phone" hint="optional" value={profile.phone} onChange={e => set("phone", e.target.value)} placeholder="(555) 123-4567" />
      </div>

      <div style={{ marginTop: 8, fontSize: 13, color: complete ? T.accent : T.gold, fontWeight: 600 }}>
        {complete ? "✓ Profile ready — your emails will fill in automatically." : "Add at least your name, grad year, and email for the best emails."}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// COACH CARD
// ═══════════════════════════════════════════════════════════════
function CoachCard({ coach, saved, onToggleSave, onEmail }) {
  return (
    <div style={{
      background: T.card, borderRadius: 14, border: `1px solid ${T.line}`,
      padding: "15px 16px", display: "flex", gap: 12, alignItems: "flex-start",
      animation: "fadeIn 0.25s ease", boxShadow: "0 1px 2px rgba(20,40,40,0.04)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: T.faint, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {coach.Title}
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, color: T.ink, margin: "1px 0 2px" }}>{coach.Name}</div>
        <div style={{ fontSize: 13, color: T.sub }}>
          {coach.School}{coach.Gender ? ` · ${coach.Gender}` : ""}{coach.Conference ? ` · ${coach.Conference}` : ""}
        </div>
        <div style={{ marginTop: 6 }}>
          {coach.Email
            ? <a href={`mailto:${coach.Email}`} style={{ fontSize: 13, color: T.accent, textDecoration: "none", fontWeight: 600 }}>{coach.Email}</a>
            : <span style={{ fontSize: 12, color: T.gold, fontWeight: 600 }}>No email found yet</span>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
        <button onClick={onToggleSave} title={saved ? "Remove from My List" : "Save to My List"} style={{
          width: 40, height: 40, borderRadius: 10, cursor: "pointer",
          border: `1px solid ${saved ? T.accent : T.line}`,
          background: saved ? T.accentSoft : "#fff", fontSize: 18, lineHeight: 1,
          color: saved ? T.accent : T.faint,
        }}>{saved ? "★" : "☆"}</button>
        <PrimaryBtn onClick={onEmail} style={{ padding: "9px 12px", fontSize: 13, justifyContent: "center" }}>Email</PrimaryBtn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EMAIL MODAL
// ═══════════════════════════════════════════════════════════════
function EmailModal({ coach, profile, onClose }) {
  const initial = useMemo(() => buildEmail(profile, coach), [profile, coach]);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [copied, setCopied] = useState("");

  const profileThin = !profile.firstName && !profile.lastName;

  const copy = async (text, which) => {
    try { await navigator.clipboard.writeText(text); }
    catch { /* older browsers */ }
    setCopied(which);
    setTimeout(() => setCopied(""), 1400);
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,30,30,0.45)", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center", padding: "0",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#fff", width: "100%", maxWidth: 640, maxHeight: "92vh", overflowY: "auto",
        borderRadius: "18px 18px 0 0", padding: "20px 20px 26px", animation: "fadeIn 0.2s ease",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.ink }}>Email {coach.Name}</div>
            <div style={{ fontSize: 13, color: T.sub }}>{coach.Title} · {coach.School}</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "#f0f4f3", width: 34, height: 34, borderRadius: 8, fontSize: 18, cursor: "pointer", color: T.sub }}>✕</button>
        </div>

        {profileThin && (
          <div style={{ background: "#fdf6e3", color: "#9a7a1e", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 12 }}>
            Tip: fill in <b>My Profile</b> first and this email writes itself.
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>
          To {coach.Email ? "" : "· no email found — use “Find missing email” or add it manually"}
        </div>
        <div style={{ padding: "10px 12px", background: "#f6f9f8", borderRadius: 10, fontSize: 14, color: coach.Email ? T.ink : T.gold, marginBottom: 14, wordBreak: "break-all" }}>
          {coach.Email || "(no address)"}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>Subject</div>
        <input value={subject} onChange={e => setSubject(e.target.value)} style={{
          width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.line}`,
          fontSize: 14, marginBottom: 14, outline: "none", color: T.ink, background: "#fbfdfc",
        }} />

        <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 5 }}>Message</div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={13} style={{
          width: "100%", padding: "12px 13px", borderRadius: 12, border: `1px solid ${T.line}`,
          fontSize: 14, lineHeight: 1.5, resize: "vertical", outline: "none", color: T.ink,
          background: "#fbfdfc", marginBottom: 16,
        }} />

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a href={mailtoLink(coach, subject, body)} style={{ textDecoration: "none", flex: "1 1 200px" }}>
            <PrimaryBtn style={{ width: "100%", justifyContent: "center" }} disabled={!coach.Email}>
              ✉ Open in email app
            </PrimaryBtn>
          </a>
          <GhostBtn onClick={() => copy(body, "body")} style={{ flex: "1 1 130px", textAlign: "center", padding: "12px 15px" }}>
            {copied === "body" ? "Copied ✓" : "Copy message"}
          </GhostBtn>
          <GhostBtn onClick={() => copy(coach.Email || "", "addr")} style={{ flex: "0 1 auto", textAlign: "center", padding: "12px 15px" }} disabled={!coach.Email}>
            {copied === "addr" ? "Copied ✓" : "Copy address"}
          </GhostBtn>
        </div>
        {!coach.Email && (
          <div style={{ fontSize: 12, color: T.faint, marginTop: 10, textAlign: "center" }}>
            “Open in email app” unlocks once an email address is found for this coach.
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FIND TAB
// ═══════════════════════════════════════════════════════════════
function FindTab({ profile, setProfile, results, setResults, savedKeys, toggleSave, openEmail }) {
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState(profile.teamGender || "Women's");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => { setGender(profile.teamGender || "Women's"); }, [profile.teamGender]);

  const genderWord = g => (g === "Men's" ? "men" : "women");
  const sport = (profile.sport || "").trim();
  const sportLower = sport.toLowerCase();
  const hasSport = sport.length >= 2;
  // Track & Field programs also cover cross country — search both for that sport only.
  const searchSport = /track\s*&?\s*field/i.test(sport) ? "track and field / cross country" : sport;

  const changeSport = v => { const dg = defaultGenderFor(v); setProfile(p => ({ ...p, sport: v, ...(dg ? { teamGender: dg } : {}) })); };

  async function searchSchool() {
    const school = query.trim();
    if (!school) return;
    if (!hasSport) { setStatus("Choose your sport above first."); return; }
    setBusy(true); setStatus(`Looking up ${gender.toLowerCase()} ${sportLower} coaches at ${school}…`);
    try {
      const g = genderWord(gender);
      const prompt = `Find the ${g}'s ${searchSport} coaching staff at ${school} (a U.S. college or university).
Go to their OFFICIAL athletics website coaches/staff directory page for ${g}'s ${sportLower} — make sure it is the ${g}'s program, not the other gender's program of the same sport.
Extract EVERY coach — head coach and ALL assistants. Get their exact title, full name, and email address.
Emails are usually shown in the staff directory next to the name and phone number.

Return ONLY a valid JSON object, no markdown:
{"schoolName": "Official School Name", "conference": "Conference Name or null", "pageUrl": "https://exact-coaches-page-url", "coaches": [{"title": "Head Coach", "name": "First Last", "email": "coach@school.edu"}]}
- Use the EXACT title from the page. Use null for email only if genuinely not listed. Never invent names or emails.
- If the program does not exist, return {"schoolName": "${school}", "coaches": []}.`;
      const text = await geminiSearch(prompt);
      const parsed = extractJson(text);
      const obj = parsed && !Array.isArray(parsed) ? parsed : { coaches: Array.isArray(parsed) ? parsed : [] };
      const schoolName = obj.schoolName || school;
      const conf = obj.conference && obj.conference !== "null" ? obj.conference : "";
      const rows = (Array.isArray(obj.coaches) ? obj.coaches : [])
        .filter(c => c && (c.name || "").length > 2)
        .map(c => ({
          School: schoolName, Conference: conf, Division: "", Gender: gender,
          Title: c.title || "Coach", Name: c.name,
          Email: c.email && String(c.email).includes("@") ? c.email : "",
          _pageUrl: obj.pageUrl || "",
        }));
      if (rows.length === 0) {
        setStatus(`Couldn't find a ${gender.toLowerCase()} ${sportLower} staff for “${school}”. Check the spelling or try the full official name.`);
      } else {
        // Prepend new results, de-duped by coach identity
        setResults(prev => {
          const keys = new Set(prev.map(coachKey));
          const fresh = rows.filter(r => !keys.has(coachKey(r)));
          return [...fresh, ...prev];
        });
        setStatus(`Found ${rows.length} coach${rows.length !== 1 ? "es" : ""} at ${schoolName}.`);
      }
    } catch (e) {
      setStatus(e.message);
    }
    setBusy(false);
  }

  async function findMissing() {
    const need = results.filter(c => !c.Email);
    if (!need.length) return;
    setBusy(true); cancelRef.current = false;
    let found = 0;
    // group by school+gender to fetch each page once
    const groups = {};
    need.forEach(c => { (groups[`${c.School}||${c.Gender}`] ||= []).push(c); });
    const keys = Object.keys(groups);
    for (let i = 0; i < keys.length; i++) {
      if (cancelRef.current) break;
      const [school, g] = keys[i].split("||");
      setStatus(`Checking the live page for ${school}… (${i + 1}/${keys.length})`);
      try {
        let pageUrl = groups[keys[i]].find(c => c._pageUrl)?._pageUrl;
        if (!pageUrl) {
          const urlText = await geminiSearch(`What is the exact URL of the coaches/staff directory page for the ${genderWord(g)}'s ${sportLower} program at ${school}? Reply with ONLY the URL.`);
          const m = urlText.match(/https?:\/\/[^\s"'<>]+/);
          pageUrl = m ? m[0] : null;
        }
        if (!pageUrl) continue;
        const rows = await fetchPageRows(pageUrl);
        setResults(prev => prev.map(coach => {
          if (coach.School === school && coach.Gender === g && !coach.Email) {
            const ln = lastName(coach.Name).toLowerCase();
            const match = rows.find(r => r.text.toLowerCase().includes(ln) && r.email);
            if (match) { found++; return { ...coach, Email: match.email }; }
          }
          return coach;
        }));
      } catch { /* skip this school */ }
      await new Promise(r => setTimeout(r, 2500));
    }
    setStatus(`Done — found ${found} more email${found !== 1 ? "s" : ""}.`);
    setBusy(false);
  }

  const missingCount = results.filter(c => !c.Email).length;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Search hero */}
      <div style={{ background: T.card, borderRadius: 16, border: `1px solid ${T.line}`, padding: "18px 18px 20px", marginBottom: 16, boxShadow: "0 1px 3px rgba(20,40,40,0.05)" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: T.ink, marginBottom: 3 }}>Look up a college's coaches</div>
        <div style={{ fontSize: 13, color: T.sub, marginBottom: 14 }}>Type a school you're interested in. We'll pull its {hasSport ? sportLower + " " : ""}staff and emails.</div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 150px", minWidth: 140 }}>
            <div style={{ fontSize: 10, letterSpacing: 1, color: T.faint, textTransform: "uppercase", marginBottom: 4, fontWeight: 700 }}>Sport</div>
            <input list="rcf-sports" value={sport} onChange={e => changeSport(e.target.value)} placeholder="Track & Field"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 10, border: `1px solid ${T.line}`, fontSize: 14, outline: "none", color: T.ink, background: "#fbfdfc" }} />
            <datalist id="rcf-sports">{SPORTS.map(s => <option key={s} value={s} />)}</datalist>
          </div>
          <div style={{ flex: "1 1 180px", minWidth: 160 }}>
            <div style={{ fontSize: 10, letterSpacing: 1, color: T.faint, textTransform: "uppercase", marginBottom: 4, fontWeight: 700 }}>Team</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["Women's", "Men's"].map(g => (
                <GhostBtn key={g} active={gender === g} onClick={() => setGender(g)} style={{ flex: 1, padding: "8px 6px" }}>{g}</GhostBtn>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !busy) searchSchool(); }}
            placeholder="e.g. Stanford, Oregon, Villanova…"
            style={{ flex: 1, padding: "13px 15px", borderRadius: 12, border: `1px solid ${T.line}`, fontSize: 16, outline: "none", color: T.ink, background: "#fbfdfc" }}
          />
          <PrimaryBtn onClick={searchSchool} disabled={busy || !query.trim() || !hasSport} style={{ padding: "0 20px" }}>
            {busy ? <Spinner /> : "Search"}
          </PrimaryBtn>
        </div>
        {!hasSport && (
          <div style={{ marginTop: 8, fontSize: 12, color: T.gold, fontWeight: 600 }}>
            Choose your sport above to start searching.
          </div>
        )}

        <button onClick={() => setBrowseOpen(o => !o)} style={{ marginTop: 12, background: "none", border: "none", color: T.accent, fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 }}>
          {browseOpen ? "▾" : "▸"} Not sure which schools? Browse programs by division & conference
        </button>
        {browseOpen && <BrowsePanel gender={gender} sport={sport} setBusy={setBusy} busy={busy} setStatus={setStatus} setResults={setResults} cancelRef={cancelRef} />}
      </div>

      {status && (
        <div style={{ fontSize: 13, color: busy ? T.accent : T.sub, marginBottom: 14, padding: "10px 14px", background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
          {busy && <Spinner size={14} color={T.accent} />}{status}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>
            {results.length} coach{results.length !== 1 ? "es" : ""} found
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {missingCount > 0 && (
              <GhostBtn onClick={findMissing} disabled={busy} style={{ padding: "8px 13px", fontSize: 13 }}>
                Find {missingCount} missing email{missingCount !== 1 ? "s" : ""}
              </GhostBtn>
            )}
            <GhostBtn onClick={() => { setResults([]); setStatus(""); }} style={{ padding: "8px 13px", fontSize: 13 }}>Clear</GhostBtn>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {results.map(c => (
          <CoachCard key={coachKey(c)} coach={c} saved={savedKeys.has(coachKey(c))}
            onToggleSave={() => toggleSave(c)} onEmail={() => openEmail(c)} />
        ))}
      </div>

      {results.length === 0 && !busy && (
        <div style={{ textAlign: "center", color: T.faint, padding: "40px 20px", fontSize: 14 }}>
          <div style={{ fontSize: 40, opacity: 0.35, marginBottom: 8 }}>🔎</div>
          Search a school above to see its coaches here.
        </div>
      )}
    </div>
  );
}

// ── Browse panel — schools-first discovery (ported from the Python scraper) ──
// Instead of trusting Gemini's conference list (which drops real conferences for
// oddly-structured sports like fencing), we enumerate schools directly in
// alphabetical chunks, then derive the conference filter from what we find.
const ALPHA_CHUNKS = [["A", "F"], ["G", "M"], ["N", "S"], ["T", "Z"]];

function BrowsePanel({ gender, sport = "", busy, setBusy, setStatus, setResults, cancelRef }) {
  const [division, setDivision] = useState("Division I");
  const [schools, setSchools] = useState([]);
  const [selSchools, setSelSchools] = useState([]); // school names picked for scraping
  const [confFilter, setConfFilter] = useState(""); // "" = all derived conferences
  const [discovering, setDiscovering] = useState(false);
  const [scraping, setScraping] = useState(false);
  const genderWord = g => (g === "Men's" ? "men" : "women");
  const sportLower = (sport || "").toLowerCase();
  const hasSport = (sport || "").trim().length >= 2;

  const dedupe = list => {
    const seen = new Set(); const out = [];
    for (const s of list) { const k = (s.name || "").trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(s); } }
    return out;
  };

  // The school list is specific to this gender + division — clear it if either
  // changes so nobody acts on a stale, wrong-scope list.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setSchools([]); setSelSchools([]); setConfFilter("");
  }, [gender, division]);

  async function discoverSchools() {
    if (!hasSport) return;
    setBusy(true); setDiscovering(true); setSchools([]); setSelSchools([]); setConfFilter("");
    cancelRef.current = false;
    const gLabel = gender; // "Women's" / "Men's"
    const found = [];
    for (const [lo, hi] of ALPHA_CHUNKS) {
      if (cancelRef.current) { setStatus("Stopped."); break; }
      setStatus(`Finding ${gLabel.toLowerCase()} ${sportLower} programs in ${division}… (${lo}–${hi})`);
      try {
        const text = await geminiSearch(`List EVERY college or university in NCAA ${division} whose name starts with a letter from ${lo} to ${hi} (inclusive) that currently sponsors a varsity ${gLabel} ${sportLower} program.
Be exhaustive — include every school that sponsors this exact program, even small or lesser-known ones, and include schools that compete in sport-specific or independent conferences. Do NOT confuse this with a different gender's program of the same sport.
Return ONLY a JSON array, no markdown: [{"name":"School Name","state":"XX","conference":"Conference Name"}]
If no schools in this letter range sponsor ${gLabel} ${sportLower}, return [].`);
        const arr = extractJsonArray(text).filter(s => s && s.name)
          .map(s => ({ ...s, conference: (s.conference || "").trim().replace(/^the\s+/i, "") }));
        found.push(...arr);
        setSchools(dedupe(found)); // incremental — schools appear as chunks finish
      } catch { /* skip this chunk, keep going */ }
      if (!cancelRef.current) await new Promise(r => setTimeout(r, 3000));
    }
    const unique = dedupe(found);
    setSchools(unique);
    setStatus(unique.length
      ? `Found ${unique.length} ${gLabel.toLowerCase()} ${sportLower} program${unique.length !== 1 ? "s" : ""}. Select the schools you want, then get their coaches.`
      : `No ${gLabel.toLowerCase()} ${sportLower} programs found in ${division}.`);
    setDiscovering(false); setBusy(false);
  }

  // Fetch coaches for one school; returns how many new rows were added.
  async function fetchCoachesForSchool(s) {
    const g = genderWord(gender);
    const text = await geminiSearch(`Go to the official athletics website for ${s.name}${s.state ? ` (${s.state})` : ""}${s.conference ? `, ${s.conference}` : ""}. Navigate to their ${g}'s ${sportLower} COACHES page — make sure it is the ${g}'s program, not the other gender's. Extract every coach — head and all assistants — with exact title, full name, and email.
Return ONLY JSON: {"pageUrl":"...","coaches":[{"title":"","name":"","email":""}]}. Use null for email only if not listed. Never invent data.`);
    const parsed = extractJson(text);
    const obj = parsed && !Array.isArray(parsed) ? parsed : { coaches: Array.isArray(parsed) ? parsed : [] };
    const rows = (obj.coaches || []).filter(c => c && (c.name || "").length > 2).map(c => ({
      School: s.name, Conference: s.conference || "", Division: division, Gender: gender,
      Title: c.title || "Coach", Name: c.name,
      Email: c.email && String(c.email).includes("@") ? c.email : "", _pageUrl: obj.pageUrl || "",
    }));
    let added = 0;
    setResults(prev => {
      const keys = new Set(prev.map(coachKey));
      const fresh = rows.filter(r => !keys.has(coachKey(r)));
      added = fresh.length;
      return [...fresh, ...prev];
    });
    return added;
  }

  // Scrape every school the athlete selected, one after another.
  async function scrapeSelected() {
    const targets = schools.filter(s => selSchools.includes(s.name));
    if (!targets.length) return;
    setBusy(true); setScraping(true); cancelRef.current = false;
    let total = 0;
    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) { setStatus(`Stopped after ${i} of ${targets.length} schools.`); break; }
      const s = targets[i];
      setStatus(`Getting ${gender.toLowerCase()} ${sportLower} coaches… (${i + 1}/${targets.length}) ${s.name}`);
      try { total += await fetchCoachesForSchool(s); } catch { /* skip, keep going */ }
      if (!cancelRef.current && i < targets.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
    if (!cancelRef.current) setStatus(`Done — added ${total} coach${total !== 1 ? "es" : ""} from ${targets.length} school${targets.length !== 1 ? "s" : ""}.`);
    setScraping(false); setBusy(false);
  }

  const toggleSchool = name => setSelSchools(p => p.includes(name) ? p.filter(x => x !== name) : [...p, name]);
  const derivedConfs = [...new Set(schools.map(s => (s.conference || "").trim()).filter(Boolean))].sort();
  const shownSchools = confFilter ? schools.filter(s => (s.conference || "").trim() === confFilter) : schools;
  const shownNames = shownSchools.map(s => s.name);
  const allShownSelected = shownNames.length > 0 && shownNames.every(n => selSchools.includes(n));

  return (
    <div style={{ marginTop: 12, paddingTop: 14, borderTop: `1px solid ${T.line}` }}>
      {!hasSport && (
        <div style={{ fontSize: 12, color: T.gold, fontWeight: 600, marginBottom: 10 }}>
          Choose your sport above to browse programs.
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {["Division I", "Division II", "Division III"].map(d => (
          <GhostBtn key={d} active={division === d} onClick={() => !busy && setDivision(d)} style={{ flex: 1, padding: "8px 0", textAlign: "center" }}>{d.replace("Division ", "D")}</GhostBtn>
        ))}
      </div>

      <GhostBtn onClick={discoverSchools} disabled={busy || !hasSport} style={{ width: "100%", textAlign: "center", padding: "10px", marginBottom: 8, opacity: hasSport ? 1 : 0.5 }}>
        {discovering ? "Finding all programs…" : `Find all ${gender.toLowerCase()} ${sportLower || "—"} programs in ${division.replace("Division ", "D")}`}
      </GhostBtn>
      {discovering && (
        <GhostBtn onClick={() => { cancelRef.current = true; }} style={{ width: "100%", textAlign: "center", padding: "8px", marginBottom: 8, color: T.danger, borderColor: "#f0d5d0" }}>
          Stop
        </GhostBtn>
      )}
      {hasSport && !discovering && schools.length === 0 && (
        <div style={{ fontSize: 11, color: T.faint, marginBottom: 8, lineHeight: 1.5 }}>
          This scans the whole division so it catches every program (even independents) — it runs a few searches and takes a minute or two.
        </div>
      )}

      {derivedConfs.length > 0 && (
        <select value={confFilter} onChange={e => setConfFilter(e.target.value)} disabled={busy}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.line}`, fontSize: 13, marginBottom: 10, background: "#fbfdfc", color: T.ink }}>
          <option value="">All conferences ({schools.length} schools)</option>
          {derivedConfs.map(c => <option key={c} value={c}>{c} ({schools.filter(s => (s.conference || "").trim() === c).length})</option>)}
        </select>
      )}

      {shownSchools.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 11, color: T.sub, fontWeight: 600 }}>
              {selSchools.length > 0 ? `${selSchools.length} selected` : "Tap schools to select them"}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setSelSchools(p => allShownSelected ? p.filter(n => !shownNames.includes(n)) : [...new Set([...p, ...shownNames])])}
                disabled={busy} style={{ background: "none", border: "none", color: T.accent, fontWeight: 600, fontSize: 12, cursor: "pointer", padding: 0 }}>
                {allShownSelected ? "Deselect all" : "Select all" + (confFilter ? " shown" : "")}
              </button>
              {selSchools.length > 0 && (
                <button onClick={() => setSelSchools([])} disabled={busy} style={{ background: "none", border: "none", color: T.faint, fontWeight: 600, fontSize: 12, cursor: "pointer", padding: 0 }}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 10 }}>
            {shownSchools.map(s => {
              const on = selSchools.includes(s.name);
              return (
                <GhostBtn key={s.name} active={on} onClick={() => toggleSchool(s.name)} disabled={busy && !scraping}
                  style={{ fontSize: 13, padding: "7px 11px" }} title={s.conference || ""}>
                  {on ? "✓ " : ""}{s.name}
                </GhostBtn>
              );
            })}
          </div>
          <PrimaryBtn onClick={scrapeSelected} disabled={busy || selSchools.length === 0}
            style={{ width: "100%", justifyContent: "center" }}>
            {scraping
              ? <><Spinner /> Getting coaches…</>
              : selSchools.length === 0
                ? "Select schools to get coaches"
                : `Get coaches for ${selSchools.length} ${selSchools.length === 1 ? "school" : "schools"}`}
          </PrimaryBtn>
          {scraping && (
            <GhostBtn onClick={() => { cancelRef.current = true; }} style={{ width: "100%", textAlign: "center", padding: "8px", marginTop: 8, color: T.danger, borderColor: "#f0d5d0" }}>
              Stop
            </GhostBtn>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MY LIST TAB
// ═══════════════════════════════════════════════════════════════
function MyListTab({ saved, setSaved, savedKeys, toggleSave, openEmail }) {
  function exportCSV() {
    const fields = ["School", "Conference", "Gender", "Title", "Name", "Email"];
    const lines = [fields.join(",")];
    saved.forEach(c => lines.push(fields.map(f => `"${String(c[f] || "").replace(/"/g, '""')}"`).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my_coach_list.csv";
    a.click();
  }

  if (saved.length === 0) {
    return (
      <div style={{ textAlign: "center", color: T.faint, padding: "60px 20px", fontSize: 15 }}>
        <div style={{ fontSize: 44, opacity: 0.35, marginBottom: 10 }}>★</div>
        <div style={{ fontWeight: 600, color: T.sub, marginBottom: 4 }}>Your list is empty</div>
        Tap the ☆ on any coach to save them here for later.
      </div>
    );
  }

  const withEmail = saved.filter(c => c.Email).length;
  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.ink }}>{saved.length} saved coach{saved.length !== 1 ? "es" : ""}</div>
          <div style={{ fontSize: 13, color: T.sub }}>{withEmail} with an email address</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <GhostBtn onClick={exportCSV} style={{ padding: "9px 14px" }}>↓ Export CSV</GhostBtn>
          <GhostBtn onClick={() => { if (confirm("Clear your whole saved list?")) setSaved([]); }} style={{ padding: "9px 14px", color: T.danger, borderColor: "#f0d5d0" }}>Clear all</GhostBtn>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {saved.map(c => (
          <CoachCard key={coachKey(c)} coach={c} saved={savedKeys.has(coachKey(c))}
            onToggleSave={() => toggleSave(c)} onEmail={() => openEmail(c)} />
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// APP SHELL
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [profile, setProfile] = useStored("rcf_profile", EMPTY_PROFILE);
  const [saved, setSaved] = useStored("rcf_saved", []);
  const [results, setResults] = useState([]);
  const [tab, setTab] = useState(() => {
    // First-time users land on the profile so their emails are ready.
    try {
      const p = JSON.parse(localStorage.getItem("rcf_profile") || "{}");
      return p.firstName ? "find" : "profile";
    } catch { return "find"; }
  });
  const [emailCoach, setEmailCoach] = useState(null);

  const savedKeys = useMemo(() => new Set(saved.map(coachKey)), [saved]);

  function toggleSave(coach) {
    setSaved(prev => {
      const k = coachKey(coach);
      return prev.some(c => coachKey(c) === k) ? prev.filter(c => coachKey(c) !== k) : [{ ...coach }, ...prev];
    });
  }

  const tabs = [
    ["find", "Find Coaches"],
    ["list", `My List${saved.length ? ` (${saved.length})` : ""}`],
    ["profile", "My Profile"],
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.ink, paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ background: T.accent, color: "#fff", padding: "16px 18px 0" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ fontSize: 22 }}>🏃</span>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.3 }}>Coach Finder</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Reach college coaches — any sport</div>
            </div>
          </div>
          <div style={{ fontSize: 10, opacity: 0.5 }} title="build version">v{BUILD_VERSION}</div>
        </div>
        {/* Tabs */}
        <div style={{ maxWidth: 720, margin: "14px auto 0", display: "flex", gap: 4 }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              flex: 1, padding: "12px 6px", border: "none", cursor: "pointer",
              background: tab === id ? T.bg : "transparent",
              color: tab === id ? T.accentDark : "#fff",
              fontSize: 13.5, fontWeight: 700,
              borderRadius: "10px 10px 0 0",
              opacity: tab === id ? 1 : 0.9,
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 14px 0" }}>
        {tab === "find" && (
          <FindTab profile={profile} setProfile={setProfile} results={results} setResults={setResults}
            savedKeys={savedKeys} toggleSave={toggleSave} openEmail={setEmailCoach} />
        )}
        {tab === "list" && (
          <MyListTab saved={saved} setSaved={setSaved} savedKeys={savedKeys}
            toggleSave={toggleSave} openEmail={setEmailCoach} />
        )}
        {tab === "profile" && <ProfileTab profile={profile} setProfile={setProfile} />}
      </div>

      {emailCoach && <EmailModal coach={emailCoach} profile={profile} onClose={() => setEmailCoach(null)} />}

      <div style={{ maxWidth: 720, margin: "28px auto 0", padding: "0 16px", fontSize: 11.5, color: T.faint, lineHeight: 1.6, textAlign: "center" }}>
        Coach info comes from AI web search and can occasionally be outdated or miss an email — double-check before you send. Your profile and saved list stay on this device only.
      </div>
    </div>
  );
}
