import { openUrl } from "../../../tauri/shell";

const URL_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Opens in the system browser; a plain new window outside the app. */
async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * A plugin's own text, shown as written, except that an http(s) address in it
 * becomes a link to the system browser (the webview must never navigate away
 * from Settings). Nothing else in the text is interpreted.
 */
export function PluginText({ text }: { text: string }): JSX.Element {
  // split() with a capture group keeps the addresses at the odd indexes.
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={index}
            href={part}
            onClick={(event) => {
              event.preventDefault();
              void openExternal(part);
            }}
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
