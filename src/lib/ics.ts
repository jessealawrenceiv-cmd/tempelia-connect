// Minimal RFC 5545 iCalendar generator for a single VEVENT.
// Works with Google Calendar, Apple Calendar, Outlook, etc.

function pad(n: number) { return n.toString().padStart(2, "0"); }

// Format a Date as a floating (no TZ) local-time value: YYYYMMDDTHHmmss
function fmtLocal(d: Date): string {
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}
function fmtUtc(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}
function fmtDateOnly(d: Date): string {
  return d.getFullYear().toString() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

// Fold long lines to 75 octets as required by RFC 5545.
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = " " + rest.slice(75);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export type IcsAppointment = {
  id: string;                    // uid — appointment id
  title: string;
  date: string;                  // YYYY-MM-DD
  time: string | null;           // HH:MM or HH:MM:SS
  notes: string | null;
  createdAt: string;             // ISO timestamp
  location?: string | null;
};

export function buildIcs(a: IcsAppointment, prodId = "-//Tempelia//Schedule//EN"): string {
  const [y, m, d] = a.date.split("-").map(Number);
  let dtStart: string;
  let dtEnd: string;
  let allDay = false;

  if (a.time && /^\d{2}:\d{2}/.test(a.time)) {
    const [hh, mm] = a.time.split(":").map(Number);
    const start = new Date(y, m - 1, d, hh, mm, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // default 1h
    dtStart = fmtLocal(start);
    dtEnd = fmtLocal(end);
  } else {
    // all-day event
    allDay = true;
    const start = new Date(y, m - 1, d);
    const end = new Date(y, m - 1, d + 1);
    dtStart = fmtDateOnly(start);
    dtEnd = fmtDateOnly(end);
  }

  const dtStamp = fmtUtc(new Date());
  const uid = `${a.id}@tempelia`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    allDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
    allDay ? `DTEND;VALUE=DATE:${dtEnd}` : `DTEND:${dtEnd}`,
    `SUMMARY:${escape(a.title)}`,
  ];
  if (a.notes) lines.push(`DESCRIPTION:${escape(a.notes)}`);
  if (a.location) lines.push(`LOCATION:${escape(a.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(fold).join("\r\n") + "\r\n";
}

export function downloadIcs(a: IcsAppointment) {
  const content = buildIcs(a);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const safeTitle = a.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "appointment";
  link.download = `${safeTitle}-${a.date}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
