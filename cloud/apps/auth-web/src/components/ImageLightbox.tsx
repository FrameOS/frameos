"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ImageLightboxProps = {
  url: string;
  alt: string;
  /** The dialog's accessible name. */
  label: string;
  /** The image's pixel size, when known (shown in the hint, and the size
   * the 1:1 view uses). */
  width?: number | undefined;
  height?: number | undefined;
  onClose: () => void;
};

// An image blown up over the whole page: fitted to the viewport, or 1:1 with
// the body scrolling (a click on the image toggles), closed by its ×, a click
// beside the image, or Esc. Used by the Preview panel (the rendered frame)
// and the Info panel's gallery. The overlay lives on <body>: the editor
// frame's transform would otherwise keep a fixed element inside a column.
export function ImageLightbox({ url, alt, label, width, height, onClose }: ImageLightboxProps) {
  const [fit, setFit] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <div aria-label={label} aria-modal className="lightbox" onClick={onClose} role="dialog">
      <button aria-label="Close" className="lightbox__close" onClick={onClose} type="button">
        <X aria-hidden size={20} />
      </button>
      <div className="lightbox__hint">
        {width && height ? `${width} × ${height} · ` : ""}
        {fit ? "click the image for 1:1" : "click the image to fit"} · Esc to close
      </div>
      <div className={`lightbox__body${fit ? " lightbox__body--fit" : ""}`}>
        <img
          alt={alt}
          className={`lightbox__image${fit ? " lightbox__image--fit" : ""}`}
          height={height}
          onClick={(event) => {
            event.stopPropagation();
            setFit((current) => !current);
          }}
          src={url}
          width={width}
        />
      </div>
    </div>,
    document.body,
  );
}
