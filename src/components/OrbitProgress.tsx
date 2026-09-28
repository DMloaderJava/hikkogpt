/**
 * Орбитальное кольцо-прогресс — общий вид «процесса» в приложении.
 *
 * Один и тот же элемент используют озвучиватель манги (`MangaProgressRing`) и
 * студия видео-историй: конический градиент показывает процент, вокруг него
 * вращаются узлы этапов (иконки или символы ✦ ♫ ▧), рядом мерцают искры, а
 * справа — подпись этапа и детали. Всё на токенах темы, поэтому в светлой теме
 * выглядит так же уместно, как в тёмной, и уважает `prefers-reduced-motion`.
 */

import { Sparkles, type LucideIcon } from "lucide-react";

/** Узел на орбите: lucide-иконка или текстовый символ. */
export interface OrbitNode {
  Icon?: LucideIcon;
  glyph?: string;
  title: string;
}

export interface OrbitProgressProps {
  /** 0..100. */
  percent: number;
  /** Подпись этапа: «Этап 3 из 5 · Озвучка слайдов». */
  label: string;
  /** Детали: «Слайд 2 из 5 · Speaker 2 · Kore». */
  detail?: string;
  /** Крутить ли орбиту и показывать «живое» состояние. */
  active?: boolean;
  /** Номер этапа — для бейджа «ЭТАП 3 / 5». */
  step?: number;
  stepsTotal?: number;
  nodes?: readonly OrbitNode[];
  /** Значение data-phase: фаза процесса (для тестов и стилей). */
  phase?: string;
  /** Подпись под процентом: «в работе» / «готово» / «ожидание». */
  stateText?: string;
  className?: string;
  testId?: string;
  percentTestId?: string;
  labelTestId?: string;
  detailTestId?: string;
}

const NODE_SPOTS = ["one", "two", "three", "four"] as const;

/** Узлы по умолчанию — символы из макета студии: искра, нота, кадр. */
const DEFAULT_ORBIT_NODES: readonly OrbitNode[] = [
  { glyph: "✦", title: "Идея" },
  { glyph: "♫", title: "Озвучка" },
  { glyph: "▧", title: "Кадры" },
  { Icon: Sparkles, title: "Сборка" },
] as const;

export function OrbitProgress({
  percent,
  label,
  detail,
  active = false,
  step,
  stepsTotal,
  nodes = DEFAULT_ORBIT_NODES,
  phase = "idle",
  stateText,
  className,
  testId = "orbit-progress",
  percentTestId,
  labelTestId,
  detailTestId,
}: OrbitProgressProps) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const state = stateText ?? (active ? "в работе" : value >= 100 ? "готово" : "ожидание");

  return (
    <div
      className={`orbit-progress${className ? ` ${className}` : ""}`}
      data-testid={testId}
      data-phase={phase}
      data-active={active ? "true" : "false"}
    >
      <div className={`orbit-field${active ? " is-active" : ""}`} aria-hidden="true">
        <div className="orbit-ring" />
        <div className="orbit-track">
          {nodes.slice(0, NODE_SPOTS.length).map((node, index) => (
            <span key={node.title} className={`orbit-node ${NODE_SPOTS[index]}`} title={node.title}>
              {node.Icon ? <node.Icon className="h-4 w-4" /> : node.glyph}
            </span>
          ))}
        </div>
        <Sparkles className="orbit-sparkle a h-3 w-3" />
        <Sparkles className="orbit-sparkle b h-3 w-3" />
      </div>

      <div className="orbit-dial" style={{ ["--orbit-progress" as string]: `${value}%` }}>
        <div className="orbit-dial-inner">
          <span className="orbit-percent" data-testid={percentTestId ?? `${testId}-percent`}>
            {value}%
          </span>
          <span className="orbit-state">{state}</span>
        </div>
      </div>

      <div className="orbit-text">
        {typeof step === "number" && typeof stepsTotal === "number" && (
          <span className="orbit-step" data-testid={`${testId}-step`}>
            ЭТАП {step} / {stepsTotal}
          </span>
        )}
        <p className="orbit-label" data-testid={labelTestId ?? `${testId}-label`}>
          {label}
        </p>
        {detail && (
          <p className="orbit-detail" data-testid={detailTestId ?? `${testId}-detail`}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
