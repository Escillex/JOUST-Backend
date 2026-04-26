"use client";

import { useState, type ReactNode } from "react";

export interface FormatConfig {
  winsToAdvance?: number;
  swissRounds?: number;
  swissPointsForWin?: number;
  swissPointsForDraw?: number;
  swissPointsForLoss?: number;
  pointsThreshold?: number;
  sessionsCount?: number;
  pointsPerSession?: number;
  bestOf?: number;
  allowDraw?: boolean | string;
  tieBreakerOrder?: string | string[];
  progressionType?: string;
  customTemplateId?: string;
  customTemplateName?: string;
  customTemplateDesc?: string;
  customRules?: Record<string, unknown> | string;
  progression?: Record<string, unknown>;
}

export interface FormatOption {
  id: string;
  label: string;
  description?: string;
  desc?: string;
  tag?: string;
  icon?: ReactNode;
  configFields?: Array<{
    key: string;
    label: string;
    placeholder: string;
    type?: "number" | "text" | "checkbox" | "select";
    min?: number;
    max?: number;
    options?: { label: string; value: string }[];
  }>;
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    id: "SINGLE_ELIMINATION",
    label: "Single Elimination",
    tag: "KNOCKOUT",
    desc: "One loss ends your run. Pure, high-stakes bracket play.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        {/* R1 */}
        <rect x="1" y="2" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".25" stroke="#52B946" strokeWidth=".75"/>
        <rect x="1" y="10" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".25" stroke="#52B946" strokeWidth=".75"/>
        <rect x="1" y="18" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".25" stroke="#52B946" strokeWidth=".75"/>
        <rect x="1" y="26" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".25" stroke="#52B946" strokeWidth=".75"/>
        {/* connectors R1→R2 */}
        <line x1="11" y1="4.5" x2="19" y2="10.5" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        <line x1="11" y1="12.5" x2="19" y2="10.5" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        <line x1="11" y1="20.5" x2="19" y2="26.5" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        <line x1="11" y1="28.5" x2="19" y2="26.5" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        {/* R2 */}
        <rect x="19" y="7" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".45" stroke="#52B946" strokeWidth=".75"/>
        <rect x="19" y="23" width="10" height="5" rx="1" fill="#52B946" fillOpacity=".45" stroke="#52B946" strokeWidth=".75"/>
        {/* connectors R2→Final */}
        <line x1="29" y1="9.5" x2="37" y2="16" stroke="#52B946" strokeOpacity=".5" strokeWidth=".6"/>
        <line x1="29" y1="25.5" x2="37" y2="16" stroke="#52B946" strokeOpacity=".5" strokeWidth=".6"/>
        {/* Final */}
        <rect x="37" y="12" width="10" height="7" rx="1" fill="#52B946" fillOpacity=".8" stroke="#52B946" strokeWidth="1"/>
      </svg>
    ),
    configFields: [
      { key: "winsToAdvance", label: "Wins to Advance", placeholder: "Default: 1", min: 1, max: 7 },
      { key: "sessionsCount", label: "Sessions / Match", placeholder: "e.g. 3 (BO3)", min: 1 },
      { key: "pointsPerSession", label: "Pts / Session", placeholder: "e.g. 21", min: 1 },
      { key: "pointsThreshold", label: "Pts Threshold", placeholder: "e.g. 100", min: 1 },
    ],
  },
  {
    id: "DOUBLE_ELIMINATION",
    label: "Double Elimination",
    tag: "BRACKET",
    desc: "Two lives. Winners & Losers brackets merge at the Grand Final.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        {/* Winners */}
        <rect x="1" y="2" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".3" stroke="#52B946" strokeWidth=".7"/>
        <rect x="1" y="8" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".3" stroke="#52B946" strokeWidth=".7"/>
        <rect x="13" y="4" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".55" stroke="#52B946" strokeWidth=".7"/>
        <line x1="9" y1="4" x2="13" y2="6" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        <line x1="9" y1="10" x2="13" y2="6" stroke="#52B946" strokeOpacity=".4" strokeWidth=".6"/>
        {/* Losers */}
        <rect x="1" y="18" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".15" stroke="#52B946" strokeWidth=".7" strokeDasharray="2,1"/>
        <rect x="1" y="24" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".15" stroke="#52B946" strokeWidth=".7" strokeDasharray="2,1"/>
        <rect x="13" y="20" width="8" height="4" rx="1" fill="#52B946" fillOpacity=".3" stroke="#52B946" strokeWidth=".7" strokeDasharray="2,1"/>
        <line x1="9" y1="20" x2="13" y2="22" stroke="#52B946" strokeOpacity=".3" strokeWidth=".6"/>
        <line x1="9" y1="26" x2="13" y2="22" stroke="#52B946" strokeOpacity=".3" strokeWidth=".6"/>
        {/* Drop from winners to losers */}
        <line x1="13" y1="8" x2="5" y2="18" stroke="#52B946" strokeOpacity=".25" strokeWidth=".6" strokeDasharray="2,1"/>
        {/* Grand Final */}
        <rect x="35" y="10" width="12" height="11" rx="1.5" fill="#52B946" fillOpacity=".85" stroke="#52B946" strokeWidth="1"/>
        <line x1="21" y1="6" x2="35" y2="15" stroke="#52B946" strokeOpacity=".5" strokeWidth=".6"/>
        <line x1="21" y1="22" x2="35" y2="15" stroke="#52B946" strokeOpacity=".35" strokeWidth=".6" strokeDasharray="2,1"/>
      </svg>
    ),
    configFields: [
      { key: "winsToAdvance", label: "Wins to Advance", placeholder: "Default: 1", min: 1, max: 7 },
      { key: "sessionsCount", label: "Sessions / Match", placeholder: "e.g. 3 (BO3)", min: 1 },
      { key: "pointsPerSession", label: "Pts / Session", placeholder: "e.g. 21", min: 1 },
      { key: "pointsThreshold", label: "Pts Threshold", placeholder: "e.g. 100", min: 1 },
    ],
  },
  {
    id: "SWISS",
    label: "Swiss",
    tag: "SWISS",
    desc: "Matched by record each round. No eliminations until final standings.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        {[0,1,2].map((ri) =>
          [0,1].map((mi) => (
            <rect key={`${ri}-${mi}`} x={2 + ri * 16} y={4 + mi * 14} width="12" height="8" rx="1"
              fill="#52B946" fillOpacity={.15 + ri * .2} stroke="#52B946" strokeWidth=".7"/>
          ))
        )}
        {["R1","R2","R3"].map((l, i) => (
          <text key={l} x={8 + i * 16} y="30" fontSize="4" fill="#52B946" fillOpacity=".5" textAnchor="middle">{l}</text>
        ))}
      </svg>
    ),
    configFields: [
      { key: "swissRounds", label: "Swiss Rounds", placeholder: "Auto", min: 1, max: 20 },
      { key: "swissPointsForWin", label: "Points · Win", placeholder: "Default: 3", min: 0 },
      { key: "swissPointsForDraw", label: "Points · Draw", placeholder: "Default: 1", min: 0 },
      { key: "swissPointsForLoss", label: "Points · Loss", placeholder: "Default: 0", min: 0 },
      { key: "sessionsCount", label: "Sessions / Match", placeholder: "e.g. 3 (BO3)", min: 1 },
      { key: "pointsPerSession", label: "Pts / Session", placeholder: "e.g. 21", min: 1 },
      { key: "pointsThreshold", label: "Pts Threshold", placeholder: "e.g. 100", min: 1 },
    ],
  },
  {
    id: "ROUND_ROBIN",
    label: "Round Robin",
    tag: "LEAGUE",
    desc: "Everyone plays everyone. Best record takes the crown.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        {(() => {
          const n = 5, cx = 24, cy = 16, r = 11;
          const pts = Array.from({ length: n }, (_, i) => ({
            x: cx + r * Math.cos((i * 2 * Math.PI) / n - Math.PI / 2),
            y: cy + r * Math.sin((i * 2 * Math.PI) / n - Math.PI / 2),
          }));
          return (
            <>
              {pts.map((a, i) => pts.slice(i+1).map((b, j) => (
                <line key={`${i}-${j}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#52B946" strokeWidth=".5" strokeOpacity=".2"/>
              )))}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="3" fill="#52B946" fillOpacity=".75" stroke="#52B946" strokeWidth=".7"/>
              ))}
            </>
          );
        })()}
      </svg>
    ),
    configFields: [
      { key: "sessionsCount", label: "Sessions / Match", placeholder: "e.g. 3 (BO3)", min: 1 },
      { key: "pointsPerSession", label: "Pts / Session", placeholder: "e.g. 21", min: 1 },
      { key: "pointsThreshold", label: "Pts Threshold", placeholder: "e.g. 100", min: 1 },
    ],
  },
  {
    id: "FREE_FOR_ALL",
    label: "Free For All",
    tag: "FFA",
    desc: "All competitors. No brackets. Points decide the winner.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        {[
          [8,6],[24,4],[40,8],[6,20],[16,26],[32,24],[42,18],[24,15]
        ].map(([x,y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="#52B946" fillOpacity={.3 + (i % 3) * .2} stroke="#52B946" strokeWidth=".7"/>
        ))}
        {/* chaos lines */}
        <line x1="8" y1="6" x2="40" y2="18" stroke="#52B946" strokeWidth=".4" strokeOpacity=".15"/>
        <line x1="24" y1="4" x2="6" y2="20" stroke="#52B946" strokeWidth=".4" strokeOpacity=".15"/>
        <line x1="16" y1="26" x2="42" y2="8" stroke="#52B946" strokeWidth=".4" strokeOpacity=".15"/>
        <line x1="32" y1="24" x2="8" y2="6" stroke="#52B946" strokeWidth=".4" strokeOpacity=".15"/>
      </svg>
    ),
    configFields: [
      { key: "sessionsCount", label: "Sessions / Match", placeholder: "e.g. 3 (BO3)", min: 1 },
      { key: "pointsPerSession", label: "Pts / Session", placeholder: "e.g. 21", min: 1 },
      { key: "pointsThreshold", label: "Pts Threshold", placeholder: "e.g. 100", min: 1 },
    ],
  },
  {
    id: "CUSTOM",
    label: "Custom Format",
    tag: "TEMPLATE",
    desc: "Build a template with your own match rules, scoring, and progression.",
    icon: (
      <svg viewBox="0 0 48 32" width="48" height="32" fill="none">
        <rect x="4" y="4" width="40" height="24" rx="2" stroke="#52B946" strokeWidth="1.5" strokeDasharray="4 2"/>
        <path d="M16 16L24 16M24 16L32 16M24 16L24 8M24 16L24 24" stroke="#52B946" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
    configFields: [
      { key: "progressionType", label: "Progression Type", placeholder: "e.g. SWISS, ROUND_ROBIN", type: "text" },
      { key: "bestOf", label: "Best Of", placeholder: "e.g. 3", min: 1 },
      { key: "allowDraw", label: "Allow Draws", placeholder: "true/false", type: "text" },
      { key: "tieBreakerOrder", label: "Tie-Break Order", placeholder: "e.g. [points,omw]", type: "text" },
      { key: "customRules", label: "Custom Rules", placeholder: "Freeform JSON object", type: "text" },
    ],
  },
];

const FORMAT_TAGS: Record<string, string> = Object.fromEntries(FORMAT_OPTIONS.map((fmt) => [fmt.id, fmt.tag ?? fmt.id]));
const FORMAT_ICON_MAP: Record<string, ReactNode> = Object.fromEntries(FORMAT_OPTIONS.map((fmt) => [fmt.id, fmt.icon]));

export interface FormatSelectorProps {
  value: string;
  onChange: (format: string) => void;
  formatConfig: FormatConfig;
  onConfigChange: (key: keyof FormatConfig, value: any) => void;
  options?: FormatOption[];
  /** "full" = create form (expanded), "compact" = edit sidebar */
  variant?: "full" | "compact";
}

export function FormatSelector({
  value,
  onChange,
  formatConfig,
  onConfigChange,
  options,
  variant = "full",
}: FormatSelectorProps) {
  const isCompact = variant === "compact";
  const formatChoices = options && options.length
    ? options.map((option) => ({
        ...option,
        tag: option.tag || FORMAT_TAGS[option.id] || option.id,
        icon: option.icon ?? FORMAT_ICON_MAP[option.id],
        description: option.description ?? option.desc ?? "",
        configFields: option.configFields ?? FORMAT_OPTIONS.find(f => f.id === option.id)?.configFields ?? [],
      }))
    : FORMAT_OPTIONS;

  return (
    <div className="flex flex-col gap-3">
      {/* Format Cards Grid */}
      <div className={`grid gap-2 ${isCompact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}>
        {formatChoices.map((fmt) => {
          const isSelected = value === fmt.id;
          return (
            <button
              key={fmt.id}
              type="button"
              onClick={() => onChange(fmt.id)}
              className="text-left transition-all"
              style={{
                background: isSelected ? "rgba(82,185,70,0.08)" : "#101010",
                border: `2px solid ${isSelected ? "#52B946" : "#2F2F2F"}`,
                borderRadius: "10px",
                padding: isCompact ? "10px 12px" : "14px 16px",
                cursor: "pointer",
                boxShadow: isSelected ? "0 0 16px rgba(82,185,70,0.15)" : "none",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* Icon preview */}
                  {!isCompact && (
                    <div
                      style={{
                        background: "#0a0a0a",
                        border: "1px solid #1e1e1e",
                        borderRadius: "6px",
                        padding: "4px 6px",
                        flexShrink: 0,
                        opacity: isSelected ? 1 : 0.45,
                        transition: "opacity 0.2s",
                      }}
                    >
                      {fmt.icon}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="font-black uppercase tracking-[1.1px] truncate"
                        style={{
                          fontSize: isCompact ? "11px" : "13px",
                          color: isSelected ? "#52B946" : "#838383",
                        }}
                      >
                        {isCompact ? fmt.label : fmt.label}
                      </span>
                      <span
                        style={{
                          fontSize: "8px",
                          fontWeight: 900,
                          letterSpacing: "0.12em",
                          color: isSelected ? "#52B946" : "#2F2F2F",
                          background: isSelected ? "rgba(82,185,70,0.15)" : "#1a1a1a",
                          padding: "1px 5px",
                          borderRadius: "3px",
                          border: `1px solid ${isSelected ? "#52B946" : "#2F2F2F"}`,
                          flexShrink: 0,
                        }}
                      >
                        {fmt.tag}
                      </span>
                      {isSelected && (
                        <span
                          style={{
                            fontSize: "8px",
                            fontWeight: 900,
                            letterSpacing: "0.12em",
                            color: "#52B946",
                            background: "rgba(82,185,70,0.12)",
                            padding: "1px 6px",
                            borderRadius: "3px",
                            border: "1px solid #52B946",
                            display: "flex",
                            alignItems: "center",
                            gap: "3px",
                            flexShrink: 0,
                          }}
                        >
                          <span
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: "50%",
                              background: "#52B946",
                              display: "inline-block",
                              boxShadow: "0 0 5px #52B946",
                            }}
                          />
                          ACTIVE
                        </span>
                      )}
                    </div>
                    {!isCompact && (
                      <p
                        className="mt-0.5 tracking-[0.5px]"
                        style={{ fontSize: "10px", color: "#555", lineHeight: 1.4 }}
                      >
                        {fmt.description ?? fmt.desc}
                      </p>
                    )}
                  </div>
                </div>
                {/* Radio dot */}
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: `2px solid ${isSelected ? "#52B946" : "#2F2F2F"}`,
                    background: isSelected ? "#52B946" : "transparent",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 0.15s",
                  }}
                >
                  {isSelected && (
                    <svg width="7" height="7" viewBox="0 0 7 7">
                      <polyline points="1.5,3.5 3,5.5 5.5,2" stroke="white" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Format Config Fields — rendered below the cards */}
      <FormatConfigFields
        format={value}
        formatChoices={formatChoices}
        formatConfig={formatConfig}
        onConfigChange={onConfigChange}
        isCompact={isCompact}
      />
    </div>
  );
}

export default FormatSelector;

function FormatConfigFields({
  format,
  formatChoices,
  formatConfig,
  onConfigChange,
  isCompact,
}: {
  format: string;
  formatChoices: FormatOption[];
  formatConfig: FormatConfig;
  onConfigChange: (key: keyof FormatConfig, value: any) => void;
  isCompact: boolean;
}) {
  const selectedFormat = formatChoices.find((fmt) => fmt.id === format);
  const configFields = selectedFormat?.configFields ?? [];

  const inputClass = `w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] outline-none placeholder:text-[#2F2F2F]`;
  const inputWrap = `w-full min-h-[40px] rounded-[5px] flex items-center px-[12px]`;

  const Field = ({
    label,
    fieldKey,
    placeholder,
    type = "number",
    min = 0,
    max,
  }: {
    label: string;
    fieldKey: keyof FormatConfig;
    placeholder: string;
    type?: "number" | "text" | "checkbox" | "select";
    min?: number;
    max?: number;
  }) => (
    <div className="flex flex-col gap-1">
      <label className="text-[#838383] text-[9px] tracking-[1.1px] uppercase font-black">{label}</label>
      <div className={inputWrap} style={{ background: "#101010", border: "1px solid #1a1a1a" }}>
        {type === "number" ? (
          <input
            type="number"
            min={min}
            max={max}
            value={(formatConfig[fieldKey] as number) ?? ""}
            onChange={(e) =>
              onConfigChange(fieldKey, e.target.value === "" ? undefined : Number(e.target.value))
            }
            placeholder={placeholder}
            className={inputClass}
          />
        ) : type === "checkbox" ? (
          <input
            type="checkbox"
            checked={Boolean(formatConfig[fieldKey])}
            onChange={(e) => onConfigChange(fieldKey, e.target.checked)}
            className="accent-[#52B946] w-4 h-4"
          />
        ) : (
          <input
            type="text"
            value={(formatConfig[fieldKey] as string) ?? ""}
            onChange={(e) => onConfigChange(fieldKey, e.target.value)}
            placeholder={placeholder}
            className={inputClass}
          />
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        background: "#0d0d0d",
        border: "1px solid #1e1e1e",
        borderRadius: "10px",
        padding: "14px 16px",
      }}
    >
      <span className="text-[9px] font-black text-[#838383] uppercase tracking-[1.1px] block mb-3">
        Format Rules <span className="text-[#2F2F2F] font-normal">(optional)</span>
      </span>

      <div className={`grid gap-3 ${isCompact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}>
        {configFields.length === 0 ? (
          <div className="col-span-full text-[10px] text-[#838383]">
            No extra format settings available for this format.
          </div>
        ) : (
          configFields.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              fieldKey={field.key as keyof FormatConfig}
              placeholder={field.placeholder}
              type={field.type as any}
              min={field.min ?? 0}
              max={field.max ?? 999}
            />
          ))
        )}
      </div>
    </div>
  );
}