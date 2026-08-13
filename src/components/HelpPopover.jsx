import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, Info, X } from "lucide-react";
import { getOperatorHelpTopic, operatorGuideHref } from "../lib/operatorHelp.js";

export function HelpPopover({ topic: topicId, className = "" }) {
  const topic = getOperatorHelpTopic(topicId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const closeRef = useRef(null);
  const generatedId = useId().replace(/:/g, "");
  const popoverId = `operator-help-${topicId}-${generatedId}`;
  const titleId = `${popoverId}-title`;
  const descriptionId = `${popoverId}-description`;

  useEffect(() => {
    if (!open) return undefined;

    closeRef.current?.focus();

    function closeAndReturnFocus() {
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndReturnFocus();
      }
    }

    function handlePointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  function closeAndReturnFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <span className={`helpPopover ${className}`.trim()} ref={rootRef} data-help-topic={topicId}>
      <button
        type="button"
        className="helpPopoverTrigger"
        ref={triggerRef}
        aria-label={`About ${topic.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      {open && (
        <span
          className="helpPopoverPanel"
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          <span className="helpPopoverHeader">
            <strong id={titleId}>{topic.label}</strong>
            <button type="button" className="helpPopoverClose" ref={closeRef} aria-label={`Close ${topic.label} help`} onClick={closeAndReturnFocus}>
              <X size={15} aria-hidden="true" />
            </button>
          </span>
          <span className="helpPopoverCopy" id={descriptionId}>
            {topic.concept} {topic.board} {topic.operator}
          </span>
          <a className="helpPopoverLink" href={operatorGuideHref(topicId, import.meta.env.BASE_URL)}>
            <span>Learn more</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </span>
      )}
    </span>
  );
}
