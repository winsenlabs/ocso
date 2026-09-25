"use client";

// Ported from the Winsen Rho site: a slow, cursor-aware gradient in the OCSO accent (#3D5DCF).
import { useEffect, useRef } from "react";

// Each pool of colour breathes (grows and fades) on its own period and wanders on a slow
// orbit, so the surface never repeats in an obvious loop. Periods are in seconds.
type Pool = { x: number; y: number; r: number; color: string; breath: number; orbit: number; phase: number };

const POOLS: Pool[] = [
  { x: 0.18, y: 0.22, r: 0.55, color: "61, 93, 207", breath: 9, orbit: 38, phase: 0 },
  { x: 0.82, y: 0.25, r: 0.5, color: "44, 70, 178", breath: 11, orbit: 46, phase: 2.1 },
  { x: 0.55, y: 0.85, r: 0.6, color: "20, 31, 92", breath: 13, orbit: 52, phase: 4.2 },
  { x: 0.28, y: 0.78, r: 0.36, color: "96, 124, 232", breath: 7, orbit: 31, phase: 1.3 },
];

// Dark currents drawn over the colour, for depth.
const CURRENTS = [
  { x: 0.42, y: 0.12, r: 0.32, orbit: 44, phase: 0.7 },
  { x: 0.7, y: 0.62, r: 0.38, orbit: 58, phase: 3.4 },
];

// Low-resolution canvas scaled up by CSS: the upscale is the blur.
const SCALE = 0.18;
const TAU = Math.PI * 2;

export function FluidBackground() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    // Reduced motion keeps a gentle breath but drops the wander and the cursor response.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const amp = reduce ? 0.35 : 1;
    const pointer = { x: 0.5, y: 0.4, tx: 0.5, ty: 0.4, strength: 0, target: 0 };
    let frame = 0;

    const resize = () => {
      const rect = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(rect.width * SCALE));
      el.height = Math.max(1, Math.round(rect.height * SCALE));
    };

    const onMove = (e: PointerEvent) => {
      if (reduce || e.pointerType === "touch") return;
      const rect = el.getBoundingClientRect();
      pointer.tx = (e.clientX - rect.left) / rect.width;
      pointer.ty = (e.clientY - rect.top) / rect.height;
      pointer.target = 1;
    };
    const onLeave = () => (pointer.target = 0);

    const radial = (x: number, y: number, r: number, inner: string, outer: string) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, el.width, el.height);
    };

    const draw = (ms: number) => {
      const t = ms / 1000;
      const { width: w, height: h } = el;
      const m = Math.max(w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#05070d";
      ctx.fillRect(0, 0, w, h);

      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      pointer.strength += (pointer.target - pointer.strength) * 0.03;

      ctx.globalCompositeOperation = "lighter";
      for (const p of POOLS) {
        const breath = Math.sin((t / p.breath) * TAU + p.phase) * amp;
        const a = (t / p.orbit) * TAU + p.phase;
        const wander = reduce ? 0 : 0.09;
        const pull = 0.14 * pointer.strength;
        const cx = (p.x + Math.cos(a) * wander) * (1 - pull) + pointer.x * pull;
        const cy = (p.y + Math.sin(a * 1.3) * wander) * (1 - pull) + pointer.y * pull;
        const r = p.r * m * (1 + breath * 0.12);
        radial(cx * w, cy * h, r, `rgba(${p.color}, ${0.5 + breath * 0.08})`, `rgba(${p.color}, 0)`);
      }

      ctx.globalCompositeOperation = "source-over";
      for (const c of CURRENTS) {
        const a = (t / c.orbit) * TAU + c.phase;
        const wander = reduce ? 0 : 0.11;
        radial((c.x + Math.sin(a) * wander) * w, (c.y + Math.cos(a * 1.2) * wander) * h, c.r * m, "rgba(2, 3, 8, 0.85)", "rgba(2, 3, 8, 0)");
      }

      if (pointer.strength > 0.01) {
        ctx.globalCompositeOperation = "lighter";
        const pr = m * 0.4 * (0.6 + 0.4 * pointer.strength);
        radial(pointer.x * w, pointer.y * h, pr, `rgba(142, 164, 242, ${0.32 * pointer.strength})`, "rgba(142, 164, 242, 0)");
      }

      ctx.globalCompositeOperation = "source-over";
      const vignette = ctx.createLinearGradient(0, 0, 0, h);
      vignette.addColorStop(0, "rgba(5,7,13,0)");
      vignette.addColorStop(1, "rgba(5,7,13,0.75)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      frame = requestAnimationFrame(draw);
    };

    // Pause when the hero is off screen or the tab is hidden.
    let running = false;
    const start = () => {
      if (!running) {
        running = true;
        frame = requestAnimationFrame(draw);
      }
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([entry]) => (entry?.isIntersecting && !document.hidden ? start() : stop()));
    const onVisibility = () => (document.hidden ? stop() : start());

    resize();
    window.addEventListener("resize", resize);
    const host = el.parentElement ?? el;
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    io.observe(el);
    start();

    return () => {
      stop();
      io.disconnect();
      window.removeEventListener("resize", resize);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />
      <div aria-hidden className="grain absolute inset-0" />
    </>
  );
}
