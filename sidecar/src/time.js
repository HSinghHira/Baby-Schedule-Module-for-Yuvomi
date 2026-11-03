/** "07:30" -> 450. */
export function minutesOfTime(time) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
