export async function copyTextToClipboard(
  text,
  { navigatorObject = globalThis.navigator, documentObject = globalThis.document } = {}
) {
  if (!text) return false;

  const clipboard = navigatorObject?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Embedded and permission-restricted contexts can reject Clipboard API
      // writes. Fall through to the selection-based copy path.
    }
  }

  if (!documentObject?.body || typeof documentObject.createElement !== "function") return false;

  const textarea = documentObject.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  documentObject.body.appendChild(textarea);
  textarea.select();

  try {
    return documentObject.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    documentObject.body.removeChild(textarea);
  }
}
