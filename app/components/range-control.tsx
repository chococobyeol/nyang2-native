"use client";

import {
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

type RangeControlProps = {
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  ariaLabel: string;
  className?: string;
  onValueChange: (value: number) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snappedValue(value: number, min: number, max: number, step: number) {
  const safeStep = step > 0 ? step : 1;
  const precision = Math.max(0, (String(safeStep).split(".")[1] ?? "").length);
  const snapped = min + Math.round((value - min) / safeStep) * safeStep;
  return Number(clamp(snapped, min, max).toFixed(precision));
}

export default function RangeControl({
  id,
  min = 0,
  max = 1,
  step = 0.01,
  value,
  ariaLabel,
  className = "",
  onValueChange,
}: RangeControlProps) {
  const activePointerRef = useRef<number | null>(null);
  const percent = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0;

  const updateFromPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const verticalOnScreen = rect.height > rect.width;
    const span = verticalOnScreen ? rect.height : rect.width;
    const pointer = verticalOnScreen ? event.clientY - rect.top : event.clientX - rect.left;
    const thumbRadius = 11;
    const usableSpan = Math.max(1, span - thumbRadius * 2);
    const ratio = clamp((pointer - thumbRadius) / usableSpan, 0, 1);
    onValueChange(snappedValue(min + ratio * (max - min), min, max, step));
  }, [max, min, onValueChange, step]);

  const endPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Some embedded mobile browsers expose Pointer Events without capture.
    }
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    let nextValue: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextValue = value + step;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextValue = value - step;
    if (event.key === "Home") nextValue = min;
    if (event.key === "End") nextValue = max;
    if (nextValue === null) return;
    event.preventDefault();
    onValueChange(snappedValue(nextValue, min, max, step));
  }, [max, min, onValueChange, step, value]);

  return (
    <div
      id={id}
      className={`nyang-range ${className}`.trim()}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${Math.round(percent)}%`}
      style={{ "--range-progress": `${percent}%` } as CSSProperties}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        activePointerRef.current = event.pointerId;
        event.currentTarget.focus({ preventScroll: true });
        updateFromPointer(event);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Dragging still works while the pointer remains over the control.
        }
      }}
      onPointerMove={(event) => {
        if (activePointerRef.current !== event.pointerId) return;
        event.preventDefault();
        updateFromPointer(event);
      }}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <span className="nyang-range-rail" aria-hidden="true">
        <span className="nyang-range-track"><i /></span>
        <span className="nyang-range-thumb" />
      </span>
    </div>
  );
}
