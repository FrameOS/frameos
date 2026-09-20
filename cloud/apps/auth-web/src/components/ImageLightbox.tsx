"use client";

import { X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ImageLightboxProps = {
  /** The image to show; ignored when `liveCanvasRef` is given. */
  url?: string | undefined;
  alt: string;
  /** The dialog's accessible name. */
  label: string;
  /** The image's pixel size, when known (shown in the hint, and the size
   * the 1:1 view uses). */
  width?: number | undefined;
  height?: number | undefined;
  /** Live mode: a <canvas> the owner keeps painting (the preview mirrors
   * every rendered frame into it), instead of a still image. */
  liveCanvasRef?: ((canvas: HTMLCanvasElement | null) => void) | undefined;
  onClose: () => void;
};

// An image blown up over the whole page: fitted to the viewport, or 1:1 with
// the body scrolling (the zoom button in the top bar toggles), closed by its
// ×, a click beside the image, or Esc. Used by the Preview panel (the rendered
// frame) and the Info panel's gallery. The overlay lives on <body>: the editor
// frame's transform would otherwise keep a fixed element inside a column.
//
// A click ON the image does nothing here: in live mode the picture is a
// running scene, and every click, drag and right click on it belongs to the
// scene (the owner wires the canvas it gets through `liveCanvasRef`).
export function ImageLightbox({ url, alt, label, width, height, liveCanvasRef, onClose }: ImageLightboxProps) {
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
      <div className="lightbox__bar">
        <div className="lightbox__hint">
          {width && height ? `${width} × ${height} · ` : ""}
          {fit ? "fitted to the window" : "actual size"} · Esc to close
        </div>
        <button
          aria-label={fit ? "Show at actual size" : "Fit to the window"}
          aria-pressed={!fit}
          className="lightbox__button"
          onClick={(event) => {
            event.stopPropagation();
            setFit((current) => !current);
          }}
          title={fit ? "Show at actual size (1:1)" : "Fit to the window"}
          type="button"
        >
          {fit ? <ZoomIn aria-hidden size={20} /> : <ZoomOut aria-hidden size={20} />}
        </button>
        <button aria-label="Close" className="lightbox__button" onClick={onClose} type="button">
          <X aria-hidden size={20} />
        </button>
      </div>
      <div className={`lightbox__body${fit ? " lightbox__body--fit" : ""}`}>
        {liveCanvasRef ? (
          <canvas
            aria-label={alt}
            className={`lightbox__image${fit ? " lightbox__image--fit" : ""}`}
            height={height}
            onClick={(event) => event.stopPropagation()}
            ref={liveCanvasRef}
            role="img"
            width={width}
          />
        ) : (
          <img
            alt={alt}
            className={`lightbox__image${fit ? " lightbox__image--fit" : ""}`}
            height={height}
            onClick={(event) => event.stopPropagation()}
            src={url}
            width={width}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
