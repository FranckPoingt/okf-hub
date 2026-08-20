import { ChevronLeft, ChevronRight, Maximize, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { presentationSlides } from "../../lib/presentation.ts";
import { Button } from "../ui/button.tsx";
import { DocumentPreview } from "./document-editor.tsx";

export function PresentationMode({
  markdown,
  meta,
  title,
  onClose,
}: {
  markdown: string;
  meta: string;
  title: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const slides = presentationSlides(markdown);
  const total = slides.length + 1;
  const [index, setIndex] = useState(0);
  const move = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(total - 1, next)));
  }, [total]);
  const close = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    onClose();
  }, [onClose]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (root.current) {
      void root.current.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    root.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if ([" ", "ArrowRight", "PageDown"].includes(event.key)) {
        event.preventDefault();
        move(index + 1);
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        move(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        move(0);
      } else if (event.key === "End") {
        event.preventDefault();
        move(total - 1);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleFullscreen();
      } else if (event.key === "Escape" && !document.fullscreenElement) {
        close();
      }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [close, index, move, toggleFullscreen, total]);

  return (
    <div
      ref={root}
      className="presentation-mode"
      role="dialog"
      aria-modal="true"
      aria-label={`Presentation: ${title}`}
      tabIndex={-1}
    >
      <header className="presentation-header">
        <span>{meta}</span>
        <div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle fullscreen"
            title="Fullscreen (F)"
            onClick={toggleFullscreen}
          >
            <Maximize />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close presentation"
            onClick={close}
          >
            <X />
          </Button>
        </div>
      </header>

      <main className="presentation-stage" aria-live="polite">
        {index === 0
          ? (
            <section className="presentation-title-slide">
              <p>{meta}</p>
              <h1>{title}</h1>
            </section>
          )
          : (
            <section className="presentation-content-slide">
              <DocumentPreview
                key={index}
                markdown={slides[index - 1]}
                hidePageTitle={false}
              />
            </section>
          )}
      </main>

      <footer className="presentation-controls">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={index === 0}
          aria-label="Previous slide"
          onClick={() => move(index - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>{index + 1} / {total}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={index === total - 1}
          aria-label="Next slide"
          onClick={() => move(index + 1)}
        >
          <ChevronRight />
        </Button>
      </footer>
    </div>
  );
}
