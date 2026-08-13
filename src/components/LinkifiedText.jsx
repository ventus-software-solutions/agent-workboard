import { tokenizeHttpLinks } from "../../shared/taskLinks.js";

export function LinkifiedText({ children }) {
  return tokenizeHttpLinks(children).map((token, index) =>
    token.type === "link" ? (
      <a
        href={token.href}
        key={`${token.href}-${index}`}
        target="_blank"
        rel="noopener noreferrer"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {token.text}
      </a>
    ) : (
      <span key={`text-${index}`}>{token.text}</span>
    )
  );
}
