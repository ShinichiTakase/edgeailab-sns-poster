function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const value = email.trim();
  if (value.length === 0 || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at > 64) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.length > 253 || !domain.includes(".")) return false;
  return domain.split(".").every(
    (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

module.exports = { isValidEmail };
