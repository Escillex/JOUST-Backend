"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type User = { id: string; username: string; guestName?: string };

type Match = {
  id: string;
  player1: User | null;
  player2: User | null;
  winnerId?: string | null;
  winner?: User | null;
  status: string;
  roundId: string;
};

type Round = { id: string; roundNumber: number; matches: Match[] };

type Tournament = {
  id: string;
  name: string;
  format: string;
  status: string;
  winner?: User | null;
  rounds: Round[];
};

type LogEntry = { id: string; timestamp: string; action: string; details?: string };

type LeaderboardEntry = {
  rank: number;
  userId: string;
  username: string;
  guestName?: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchWinPct: number;
  omw: number;
  oomw: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const playerName = (u: User | null | undefined, fallback = "TBD") =>
  u?.guestName || u?.username || fallback;

const CARD_H = 72;   // px height of one match card
const CARD_W = 192;  // px width of one match card
const COL_GAP = 64;  // px horizontal gap between rounds
const ROW_GAP = 16;  // px vertical gap between cards in same round

// ─── MatchCard ────────────────────────────────────────────────────────────────

function MatchCard({
  match,
  onOpen,
  isAdmin,
  isUpdating,
  leaderboard,
  showPoints,
  dim,
}: {
  match: Match;
  onOpen: () => void;
  isAdmin: boolean;
  isUpdating: boolean;
  leaderboard: LeaderboardEntry[];
  showPoints?: boolean;
  dim?: boolean;
}) {
  const canScore = isAdmin && !match.winnerId && (match.player1 || match.player2);
  const p1Stats = leaderboard.find((l) => l.userId === match.player1?.id);
  const p2Stats = leaderboard.find((l) => l.userId === match.player2?.id);
  const isBye = match.player1 !== null && match.player2 === null;

  const Row = ({
    p,
    isWinner,
    stats,
    bye,
  }: {
    p: User | null;
    isWinner: boolean;
    stats?: LeaderboardEntry;
    bye?: boolean;
  }) => (
    <div
      className={`flex items-center justify-between px-3 py-2 transition-all ${
        isWinner ? "bg-[#52B946]/12" : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isWinner && (
          <div className="w-1.5 h-1.5 rounded-full bg-[#52B946] shadow-[0_0_6px_#52B946] shrink-0" />
        )}
        <div className="flex flex-col min-w-0">
          <span
            className={`text-[11px] font-black uppercase tracking-[1px] truncate ${
              p ? (isWinner ? "text-[#52B946]" : "text-white") : "text-[#333]"
            }`}
          >
            {p ? playerName(p) : bye ? "BYE" : "TBD"}
          </span>
          {showPoints && p && (
            <span className="text-[8px] text-[#555] font-black tracking-[0.8px]">
              {stats?.points ?? 0} PTS · {stats?.wins ?? 0}W-{stats?.losses ?? 0}L
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      onClick={canScore ? onOpen : undefined}
      className={`flex flex-col rounded-[10px] overflow-hidden transition-all relative group shadow-md
        ${isUpdating ? "opacity-40 pointer-events-none" : ""}
        ${dim ? "opacity-40" : ""}
        ${canScore ? "cursor-pointer" : ""}
        border-2 ${canScore ? "border-[#2F2F2F] hover:border-[#52B946]" : "border-[#1e1e1e]"}`}
      style={{
        width: CARD_W,
        minHeight: CARD_H,
        background: "linear-gradient(180deg,#242424 0%,#1c1c1c 100%)",
      }}
    >
      <Row p={match.player1} isWinner={match.winnerId === match.player1?.id} stats={p1Stats} />
      <div className="h-px bg-[#222]" />
      <Row
        p={match.player2}
        isWinner={match.winnerId === match.player2?.id}
        stats={p2Stats}
        bye={isBye}
      />
      {canScore && (
        <div className="absolute inset-0 bg-[#52B946]/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
          <span className="text-[9px] font-black uppercase tracking-[1.5px] text-[#52B946] bg-[#0d0d0d] border border-[#52B946] px-2 py-0.5 rounded-full">
            Score
          </span>
        </div>
      )}
    </div>
  );
}

// ─── SVG Connector Lines ──────────────────────────────────────────────────────

/**
 * For a single-elimination column pair, draw curved connector lines from
 * every two matches in `leftMatches` into one match in `rightMatches`.
 */
function ConnectorLines({
  leftCount,
  rightCount,
  colHeight,
}: {
  leftCount: number;
  rightCount: number;
  colHeight: number;
}) {
  // Each left card takes (CARD_H + ROW_GAP) vertical space
  const stride = CARD_H + ROW_GAP;

  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];

  for (let i = 0; i < rightCount; i++) {
    const topIdx = i * 2;
    const botIdx = i * 2 + 1;

    const topMid = topIdx * stride + CARD_H / 2;
    const botMid = Math.min(botIdx * stride + CARD_H / 2, colHeight - CARD_H / 2);
    const rightMid = (topMid + botMid) / 2;

    lines.push({ x1: 0, y1: topMid, x2: COL_GAP, y2: rightMid });
    if (botIdx < leftCount) {
      lines.push({ x1: 0, y1: botMid, x2: COL_GAP, y2: rightMid });
    }
  }

  return (
    <svg
      width={COL_GAP}
      height={colHeight}
      style={{ overflow: "visible", flexShrink: 0 }}
    >
      {lines.map((l, i) => (
        <path
          key={i}
          d={`M ${l.x1} ${l.y1} C ${COL_GAP * 0.5} ${l.y1}, ${COL_GAP * 0.5} ${l.y2}, ${l.x2} ${l.y2}`}
          stroke="#2F2F2F"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

// ─── Single / Double Elimination Bracket ──────────────────────────────────────

function EliminationBracket({
  rounds,
  format,
  champion,
  isAdmin,
  updating,
  leaderboard,
  onScore,
}: {
  rounds: Round[];
  format: string;
  champion: User | null;
  isAdmin: boolean;
  updating: string | null;
  leaderboard: LeaderboardEntry[];
  onScore: (m: Match) => void;
}) {
  // Split winners/losers/grand-finals for double elim
  const winnersRounds = rounds
    .filter((r) => r.roundNumber < 100)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  const losersRounds = rounds
    .filter((r) => r.roundNumber >= 100 && r.roundNumber < 200)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  const grandFinals = rounds.filter((r) => r.roundNumber >= 200);

  const isDouble = format === "DOUBLE_ELIMINATION";
  const mainRounds = isDouble ? winnersRounds : rounds.sort((a, b) => a.roundNumber - b.roundNumber);

  const totalRounds = mainRounds.length;

  const getRoundLabel = (r: Round) => {
    if (r.roundNumber >= 200) return "Grand Final";
    if (r.roundNumber >= 100) {
      const n = r.roundNumber - 100;
      return `Losers R${n.toString().padStart(2, "0")}`;
    }
    if (!isDouble) {
      if (r.roundNumber === totalRounds) return "Final";
      if (r.roundNumber === totalRounds - 1) return "Semi-Finals";
      if (r.roundNumber === totalRounds - 2) return "Quarter-Finals";
    }
    return `${isDouble ? "Winners " : ""}R${r.roundNumber.toString().padStart(2, "0")}`;
  };

  const RoundCol = ({
    round,
    nextRound,
    label,
    faded,
  }: {
    round: Round;
    nextRound?: Round;
    label: string;
    faded?: boolean;
  }) => {
    const colH = round.matches.length * (CARD_H + ROW_GAP) - ROW_GAP;
    return (
      <div className="flex items-stretch gap-0">
        <div className="flex flex-col" style={{ gap: ROW_GAP }}>
          <span
            className="text-[9px] font-black uppercase tracking-[1.1px] text-center mb-2"
            style={{ color: faded ? "#333" : "#52B946", width: CARD_W }}
          >
            {label}
          </span>
          {round.matches.map((m) => (
            <MatchCard
              key={m.id}
              match={m}
              onOpen={() => onScore(m)}
              isAdmin={isAdmin}
              isUpdating={updating === m.id}
              leaderboard={leaderboard}
              dim={faded}
            />
          ))}
        </div>
        {nextRound && (
          <ConnectorLines
            leftCount={round.matches.length}
            rightCount={nextRound.matches.length}
            colHeight={colH}
          />
        )}
      </div>
    );
  };

  // Champion trophy column
  const TrophyCol = () => (
    <div className="flex flex-col items-center justify-center" style={{ width: CARD_W + 32 }}>
      <span className="text-[9px] font-black uppercase tracking-[1.1px] text-[#52B946] mb-4 text-center">
        Champion
      </span>
      <div
        className={`flex flex-col items-center justify-center gap-3 rounded-[15px] p-6 border-2 transition-all ${
          champion ? "border-[#52B946] shadow-[0_0_30px_rgba(82,185,70,0.15)]" : "border-dashed border-[#2F2F2F]"
        }`}
        style={{
          width: CARD_W + 32,
          minHeight: CARD_H + 24,
          background: champion
            ? "linear-gradient(160deg,#1e2e1e 0%,#171d17 100%)"
            : "transparent",
        }}
      >
        <svg className={`w-7 h-7 ${champion ? "text-[#52B946]" : "text-[#2F2F2F]"}`} fill="currentColor" viewBox="0 0 24 24">
          <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5M19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z" />
        </svg>
        <span
          className={`text-[12px] font-black uppercase tracking-[1.1px] text-center ${
            champion ? "text-white" : "text-[#2F2F2F]"
          }`}
        >
          {champion ? playerName(champion) : "Awaiting\nFinal..."}
        </span>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-16">
      {/* Winners / Single bracket */}
      <div>
        {isDouble && (
          <div className="text-[10px] font-black uppercase tracking-[1.1px] text-[#52B946] mb-4 flex items-center gap-3">
            <span>Winners Bracket</span>
            <div className="flex-1 h-px bg-[#2F2F2F]" />
          </div>
        )}
        <div className="flex items-start gap-0 overflow-x-auto pb-4">
          {mainRounds.map((round, i) => (
            <RoundCol
              key={round.id}
              round={round}
              nextRound={mainRounds[i + 1]}
              label={getRoundLabel(round)}
            />
          ))}
          {/* Grand Finals column for Double */}
          {isDouble && grandFinals.map((round) => (
            <RoundCol
              key={round.id}
              round={round}
              label={getRoundLabel(round)}
            />
          ))}
          {/* Always show trophy */}
          {(isDouble ? grandFinals.length > 0 : true) && (
            <div className="flex items-center" style={{ marginLeft: COL_GAP }}>
              <TrophyCol />
            </div>
          )}
        </div>
      </div>

      {/* Losers bracket */}
      {isDouble && losersRounds.length > 0 && (
        <div>
          <div className="text-[10px] font-black uppercase tracking-[1.1px] text-[#838383] mb-4 flex items-center gap-3">
            <span>Losers Bracket</span>
            <div className="flex-1 h-px bg-[#2F2F2F]" />
          </div>
          <div className="flex items-start gap-0 overflow-x-auto pb-4">
            {losersRounds.map((round, i) => (
              <RoundCol
                key={round.id}
                round={round}
                nextRound={losersRounds[i + 1]}
                label={getRoundLabel(round)}
                faded
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Swiss / Round Robin Layout ───────────────────────────────────────────────

function RoundTableLayout({
  rounds,
  format,
  isAdmin,
  updating,
  leaderboard,
  onScore,
}: {
  rounds: Round[];
  format: string;
  isAdmin: boolean;
  updating: string | null;
  leaderboard: LeaderboardEntry[];
  onScore: (m: Match) => void;
}) {
  const sorted = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber);
  const currentRound = sorted.find((r) =>
    r.matches.some((m) => m.status !== "COMPLETED")
  ) ?? sorted[sorted.length - 1];

  const [activeRound, setActiveRound] = useState(currentRound?.roundNumber ?? 1);
  const displayRound = sorted.find((r) => r.roundNumber === activeRound);

  const completedCount = sorted.filter((r) =>
    r.matches.every((m) => m.status === "COMPLETED")
  ).length;

  return (
    <div className="flex flex-col gap-6">
      {/* Round selector tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {sorted.map((r) => {
          const isDone = r.matches.every((m) => m.status === "COMPLETED");
          const isActive = r.roundNumber === activeRound;
          const isCurrent = r.roundNumber === currentRound?.roundNumber;
          return (
            <button
              key={r.id}
              onClick={() => setActiveRound(r.roundNumber)}
              className={`shrink-0 px-4 py-2 rounded-[8px] text-[10px] font-black uppercase tracking-[1.1px] transition-all border-2 ${
                isActive
                  ? "border-[#52B946] bg-[#52B946]/10 text-[#52B946]"
                  : isDone
                  ? "border-[#2F2F2F] bg-[#101010] text-[#555]"
                  : "border-[#2F2F2F] bg-[#101010] text-[#838383] hover:border-[#52B946]/50"
              }`}
            >
              {format === "SWISS" ? `Swiss` : `Round`} {r.roundNumber.toString().padStart(2, "0")}
              {isCurrent && !isDone && (
                <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-[#52B946] shadow-[0_0_4px_#52B946] align-middle" />
              )}
              {isDone && <span className="ml-2 text-[#52B946]">✓</span>}
            </button>
          );
        })}
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Current Round", value: `${currentRound?.roundNumber ?? "-"} / ${sorted.length}` },
          { label: "Rounds Complete", value: `${completedCount}` },
          { label: "Format", value: format.replace("_", " ") },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-[10px] px-4 py-3" style={{ background: "#101010", border: "1px solid #1e1e1e" }}>
            <span className="block text-[8px] text-[#555] font-black uppercase tracking-[1px] mb-1">{label}</span>
            <span className="text-[12px] font-black text-white uppercase tracking-[1px]">{value}</span>
          </div>
        ))}
      </div>

      {/* Matches grid */}
      {displayRound && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {displayRound.matches.map((m, idx) => (
            <div key={m.id} className="flex flex-col gap-1">
              <span className="text-[8px] font-black text-[#555] uppercase tracking-[1px]">
                Match {(idx + 1).toString().padStart(2, "0")}
              </span>
              <MatchCard
                match={m}
                onOpen={() => onScore(m)}
                isAdmin={isAdmin}
                isUpdating={updating === m.id}
                leaderboard={leaderboard}
                showPoints
              />
            </div>
          ))}
        </div>
      )}

      {/* Standings sidebar */}
      {leaderboard.length > 0 && (
        <div
          className="rounded-[15px] overflow-hidden"
          style={{ background: "linear-gradient(180deg,#1e1e1e 0%,#181818 100%)", border: "1px solid #222" }}
        >
          <div className="px-5 py-3 border-b border-[#222]">
            <span className="text-[10px] font-black text-[#52B946] uppercase tracking-[1.1px]">Live Standings</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-[8px] font-black text-[#555] uppercase tracking-[1px] border-b border-[#222]">
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">Player</th>
                  <th className="px-4 py-2 text-center">Pts</th>
                  <th className="px-4 py-2 text-center">W-D-L</th>
                  <th className="px-4 py-2 text-center">Win%</th>
                  <th className="px-4 py-2 text-center">OMW%</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((e) => (
                  <tr key={e.userId} className="border-b border-[#1a1a1a] hover:bg-white/3 transition-colors">
                    <td className="px-4 py-3 text-[10px] font-black text-[#52B946]">#{e.rank.toString().padStart(2, "0")}</td>
                    <td className="px-4 py-3 text-[11px] font-black text-white uppercase tracking-[0.8px]">{e.guestName || e.username}</td>
                    <td className="px-4 py-3 text-[11px] font-black text-[#6FFF5E] text-center">{e.points}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{e.wins}-{e.draws ?? 0}-{e.losses}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.matchWinPct * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.omw * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Free For All Layout ──────────────────────────────────────────────────────

function FreeForAllLayout({
  rounds,
  leaderboard,
  isAdmin,
  updating,
  onScore,
}: {
  rounds: Round[];
  leaderboard: LeaderboardEntry[];
  isAdmin: boolean;
  updating: string | null;
  onScore: (m: Match) => void;
}) {
  const allMatches = rounds.flatMap((r) => r.matches);
  const pending = allMatches.filter((m) => m.status !== "COMPLETED");
  const completed = allMatches.filter((m) => m.status === "COMPLETED");

  return (
    <div className="flex flex-col gap-8">
      {/* Leaderboard-first for FFA */}
      {leaderboard.length > 0 && (
        <div
          className="rounded-[15px] overflow-hidden"
          style={{ background: "linear-gradient(180deg,#1e1e1e 0%,#181818 100%)", border: "1px solid #222" }}
        >
          <div className="px-5 py-3 border-b border-[#222] flex items-center gap-3">
            <span className="text-[10px] font-black text-[#52B946] uppercase tracking-[1.1px]">Free For All — Standings</span>
            <div className="flex-1 h-px bg-[#222]" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[8px] font-black text-[#555] uppercase tracking-[1px] border-b border-[#222]">
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">Player</th>
                  <th className="px-4 py-2 text-center">Pts</th>
                  <th className="px-4 py-2 text-center">W-D-L</th>
                  <th className="px-4 py-2 text-center">Win%</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((e, i) => (
                  <tr
                    key={e.userId}
                    className={`border-b border-[#1a1a1a] transition-colors ${i === 0 ? "bg-[#52B946]/6" : "hover:bg-white/3"}`}
                  >
                    <td className="px-4 py-3 text-[11px] font-black text-[#52B946]">
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${e.rank}`}
                    </td>
                    <td className="px-4 py-3 text-[11px] font-black text-white uppercase">{e.guestName || e.username}</td>
                    <td className="px-4 py-3 text-[12px] font-black text-[#6FFF5E] text-center">{e.points}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{e.wins}-{e.draws ?? 0}-{e.losses}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.matchWinPct * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pending matches */}
      {pending.length > 0 && (
        <div className="flex flex-col gap-3">
          <span className="text-[9px] font-black text-[#838383] uppercase tracking-[1.1px] flex items-center gap-2">
            Pending Matches
            <span className="bg-[#101010] border border-[#2F2F2F] text-[#52B946] px-2 py-0.5 rounded-full">{pending.length}</span>
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {pending.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                onOpen={() => onScore(m)}
                isAdmin={isAdmin}
                isUpdating={updating === m.id}
                leaderboard={leaderboard}
                showPoints
              />
            ))}
          </div>
        </div>
      )}

      {/* Completed matches */}
      {completed.length > 0 && (
        <div className="flex flex-col gap-3">
          <span className="text-[9px] font-black text-[#555] uppercase tracking-[1.1px]">Completed</span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {completed.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                onOpen={() => {}}
                isAdmin={false}
                isUpdating={false}
                leaderboard={leaderboard}
                dim
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Scoring Modal ────────────────────────────────────────────────────────────

function ScoringModal({
  match,
  onScore,
  onClose,
  updating,
}: {
  match: Match;
  onScore: (winnerId: string | null) => void;
  onClose: () => void;
  updating: boolean;
}) {
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-md rounded-[24px] p-8 shadow-2xl relative"
        style={{
          background: "linear-gradient(180deg,#252525 0%,#1c1c1c 100%)",
          border: "2px solid #52B946",
        }}
      >
        <button onClick={onClose} className="absolute top-5 right-5 text-[#555] hover:text-white text-lg font-black transition-colors">✕</button>
        <h2 className="text-lg font-black text-white uppercase tracking-[1.1px] mb-1">Score Match</h2>
        <p className="text-[9px] text-[#555] uppercase tracking-[1px] mb-6">Select the outcome</p>

        <div className="flex flex-col gap-2 mb-6">
          {match.player1 && (
            <button
              onClick={() => onScore(match.player1!.id)}
              disabled={updating}
              className="w-full py-3.5 px-5 bg-[#101010] border-2 border-[#222] hover:border-[#52B946] text-white rounded-[12px] transition-all flex justify-between items-center group disabled:opacity-50"
            >
              <span className="text-[12px] font-black uppercase tracking-[1px]">{playerName(match.player1)}</span>
              <span className="text-[9px] font-black text-[#52B946] opacity-0 group-hover:opacity-100 uppercase tracking-[1px]">Win →</span>
            </button>
          )}
          <button
            onClick={() => onScore(null)}
            disabled={updating}
            className="w-full py-3.5 px-5 bg-[#101010] border-2 border-[#222] hover:border-[#838383] text-[#838383] rounded-[12px] transition-all flex justify-between items-center group disabled:opacity-50"
          >
            <span className="text-[12px] font-black uppercase tracking-[1px]">Draw</span>
            <span className="text-[9px] font-black opacity-0 group-hover:opacity-100 uppercase tracking-[1px]">Stalemate →</span>
          </button>
          {match.player2 && (
            <button
              onClick={() => onScore(match.player2!.id)}
              disabled={updating}
              className="w-full py-3.5 px-5 bg-[#101010] border-2 border-[#222] hover:border-[#52B946] text-white rounded-[12px] transition-all flex justify-between items-center group disabled:opacity-50"
            >
              <span className="text-[12px] font-black uppercase tracking-[1px]">{playerName(match.player2)}</span>
              <span className="text-[9px] font-black text-[#52B946] opacity-0 group-hover:opacity-100 uppercase tracking-[1px]">Win →</span>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[9px] font-black text-[#555] uppercase tracking-[1px]">Note (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. 2-0 Victory"
            className="w-full h-20 bg-[#101010] rounded-[10px] p-3 text-xs text-white outline-none border-2 border-[#222] focus:border-[#52B946] transition-all resize-none"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Leaderboard Modal ────────────────────────────────────────────────────────

function LeaderboardModal({
  leaderboard,
  onClose,
}: {
  leaderboard: LeaderboardEntry[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        className="w-full max-w-4xl rounded-[24px] p-8 shadow-2xl relative"
        style={{
          background: "linear-gradient(180deg,#252525 0%,#1c1c1c 100%)",
          border: "2px solid #2F2F2F",
        }}
      >
        <button onClick={onClose} className="absolute top-5 right-5 text-[#555] hover:text-white text-lg font-black transition-colors">✕</button>
        <h2 className="text-2xl font-black text-[#52B946] uppercase tracking-[2px] mb-6 border-b-2 border-[#222] pb-4">Standings</h2>
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] font-black text-[#555] uppercase tracking-[1px] border-b border-[#222]">
                <th className="px-4 py-3">Rank</th>
                <th className="px-4 py-3">Player</th>
                <th className="px-4 py-3 text-center">Pts</th>
                <th className="px-4 py-3 text-center">W-D-L</th>
                <th className="px-4 py-3 text-center">Win%</th>
                <th className="px-4 py-3 text-center">OMW%</th>
                <th className="px-4 py-3 text-center">OOMW%</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-16 text-[#555] text-[11px] uppercase font-black">No data yet</td></tr>
              ) : (
                leaderboard.map((e) => (
                  <tr key={e.userId} className="border-b border-[#1a1a1a] hover:bg-white/3 transition-colors">
                    <td className="px-4 py-3 text-[11px] font-black text-[#52B946]">#{e.rank.toString().padStart(2,"0")}</td>
                    <td className="px-4 py-3 text-[12px] font-black text-white uppercase">{e.guestName || e.username}</td>
                    <td className="px-4 py-3 text-[12px] font-black text-[#6FFF5E] text-center">{e.points}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{e.wins}-{e.draws??0}-{e.losses}</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.matchWinPct*100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.omw*100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-[10px] text-[#555] text-center">{(e.oomw*100).toFixed(1)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function BracketViewContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tournamentId = searchParams.get("id");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [scoringMatch, setScoringMatch] = useState<Match | null>(null);

  useEffect(() => {
    if (tournamentId) fetchData();
    else router.push("/join_tournament");
  }, [tournamentId]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const meRes = await authenticatedFetch(`${apiUrl}/auth/me`);
      if (meRes.ok) {
        const me = await meRes.json();
        const allowed = me.roles?.some((r: string) => ["PLAYER","ORGANIZER","ADMIN"].includes(r));
        setIsAdmin(allowed ? me.roles?.some((r: string) => ["ADMIN","ORGANIZER"].includes(r)) : false);
      }
      const tRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}`);
      if (tRes.ok) {
        const t = await tRes.json();
        setTournament(t);
        addLog("ARENA STATUS", `${t.name} [${t.status}]`);
      }
      const lRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}/leaderboard`);
      if (lRes.ok) setLeaderboard(await lRes.json());
    } catch {
      addLog("ERROR", "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  const addLog = (action: string, details?: string) =>
    setLogs((prev) => [
      { id: Math.random().toString(36).slice(2), timestamp: new Date().toLocaleTimeString(), action, details },
      ...prev,
    ]);

  const handleScore = async (winnerId: string | null) => {
    if (!scoringMatch || updating) return;
    const matchId = scoringMatch.id;
    setUpdating(matchId);
    try {
      const res = await authenticatedFetch(`${apiUrl}/matches/${matchId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: winnerId || undefined }),
      });
      if (res.ok) {
        const winner = winnerId === scoringMatch.player1?.id
          ? scoringMatch.player1
          : winnerId === scoringMatch.player2?.id
          ? scoringMatch.player2
          : null;
        addLog("MATCH SCORED", winner ? `${playerName(winner)} WINS` : "DRAW");
        setScoringMatch(null);
        await fetchData();
      } else {
        const err = await res.json();
        addLog("ERROR", err.message);
      }
    } catch {
      addLog("ERROR", "Connection lost");
    } finally {
      setUpdating(null);
    }
  };

  const getChampion = () => {
    if (!tournament) return null;
    if (tournament.winner) return tournament.winner;
    const sorted = [...tournament.rounds].sort((a, b) => b.roundNumber - a.roundNumber);
    return sorted[0]?.matches.find((m) => m.status === "COMPLETED" && m.winner)?.winner ?? null;
  };

  const champion = getChampion();
  const fmt = tournament?.format ?? "";
  const isElimination = fmt === "SINGLE_ELIMINATION" || fmt === "DOUBLE_ELIMINATION";
  const isRoundBased = fmt === "SWISS" || fmt === "ROUND_ROBIN";
  const isFFA = fmt === "FREE_FOR_ALL";

  if (loading && !tournament)
    return (
      <div className="min-h-screen flex items-center justify-center text-[#52B946] font-black uppercase tracking-[1.1px] bg-[#1B1B1B]">
        Synchronizing Arena...
      </div>
    );

  return (
    <div
      className="flex flex-col min-h-screen"
      style={{ background: "linear-gradient(180deg, rgba(102,102,102,0.00) 38.15%, rgba(82,185,70,0.20) 100%), #1B1B1B" }}
    >
      <div className="max-w-7xl mx-auto w-full p-4 md:p-8 flex flex-col gap-8">

        {/* ── Header ── */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b-4 border-[#2F2F2F] pb-6">
          <div>
            <button onClick={() => router.back()} className="text-[9px] font-black text-[#555] hover:text-[#52B946] uppercase tracking-[1.1px] mb-2 block transition-colors">
              ← Back to Hub
            </button>
            <h1 className="text-3xl md:text-4xl font-black text-[#52B946] tracking-[1.1px] uppercase leading-none">
              {tournament?.name || "Tournament"} <span className="text-white/20">/ Arena</span>
            </h1>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-[15px]" style={{ background: "linear-gradient(180deg,#242424 0%,#1c1c1c 100%)" }}>
            <button
              onClick={() => setShowLeaderboard(true)}
              className="px-4 py-2 bg-[#52B946] hover:bg-[#3E9434] text-white text-[9px] font-black uppercase rounded-[8px] tracking-[1.1px] transition-all"
            >
              Standings
            </button>
            <div className="h-6 w-px bg-[#2F2F2F]" />
            <div className="flex flex-col">
              <span className="text-[7px] text-[#555] font-black uppercase tracking-[1px]">Format</span>
              <span className="text-[10px] font-black text-[#52B946] uppercase tracking-[1px]">
                {fmt.replace(/_/g, " ")}
              </span>
            </div>
            <div className="h-6 w-px bg-[#2F2F2F]" />
            <div
              className={`px-3 py-1.5 text-[9px] font-black uppercase rounded-[8px] tracking-[1px] border ${
                isAdmin ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-[#101010] text-[#555] border-[#1e1e1e]"
              }`}
            >
              {isAdmin ? "Organizer" : "Viewer"}
            </div>
          </div>
        </div>

        {/* ── Champion banner (when complete) ── */}
        {champion && (
          <div
            className="rounded-[15px] px-6 py-4 flex items-center gap-4"
            style={{ background: "linear-gradient(90deg,rgba(82,185,70,0.12) 0%,transparent 100%)", border: "1px solid rgba(82,185,70,0.3)" }}
          >
            <svg className="w-6 h-6 text-[#52B946] shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5M19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/>
            </svg>
            <div>
              <span className="text-[8px] font-black text-[#52B946] uppercase tracking-[1.1px] block">Grand Champion</span>
              <span className="text-[16px] font-black text-white uppercase tracking-[1px]">{playerName(champion)}</span>
            </div>
          </div>
        )}

        {/* ── Format-specific bracket ── */}
        <div className="overflow-x-auto">
          {tournament?.rounds && tournament.rounds.length > 0 ? (
            <>
              {isElimination && (
                <EliminationBracket
                  rounds={tournament.rounds}
                  format={fmt}
                  champion={champion}
                  isAdmin={isAdmin}
                  updating={updating}
                  leaderboard={leaderboard}
                  onScore={(m) => setScoringMatch(m)}
                />
              )}
              {isRoundBased && (
                <RoundTableLayout
                  rounds={tournament.rounds}
                  format={fmt}
                  isAdmin={isAdmin}
                  updating={updating}
                  leaderboard={leaderboard}
                  onScore={(m) => setScoringMatch(m)}
                />
              )}
              {isFFA && (
                <FreeForAllLayout
                  rounds={tournament.rounds}
                  leaderboard={leaderboard}
                  isAdmin={isAdmin}
                  updating={updating}
                  onScore={(m) => setScoringMatch(m)}
                />
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-24 rounded-[20px] border-2 border-dashed border-[#2F2F2F]">
              <p className="text-[11px] font-black text-[#555] uppercase tracking-[1.1px]">Bracket Pending — Start the tournament to generate matches</p>
            </div>
          )}
        </div>

        {/* ── Arena Log ── */}
        <div
          className="rounded-[20px] p-6 shadow-lg"
          style={{ background: "linear-gradient(180deg,#242424 0%,#1c1c1c 100%)", borderTop: "4px solid #3E9434" }}
        >
          <h3 className="text-[9px] font-black text-[#52B946] uppercase tracking-[1.1px] mb-4 border-b border-[#222] pb-2">Arena Log</h3>
          <div className="bg-[#0d0d0d] rounded-[10px] p-4 h-44 overflow-y-auto font-mono text-[9px] border border-[#1a1a1a]">
            {logs.length === 0 ? (
              <p className="text-[#2F2F2F] uppercase font-black tracking-[1px]">Awaiting activity...</p>
            ) : (
              <div className="flex flex-col gap-2">
                {logs.map((log) => (
                  <div key={log.id} className="flex flex-col border-b border-[#111] pb-2 last:border-0">
                    <div className="flex gap-4">
                      <span className="text-[#555] shrink-0 font-black">[{log.timestamp}]</span>
                      <span className="text-[#52B946] font-black uppercase tracking-[1px]">{log.action}</span>
                    </div>
                    {log.details && <span className="text-white/50 mt-0.5 ml-16 tracking-wide">{log.details}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Modals ── */}
      {showLeaderboard && (
        <LeaderboardModal leaderboard={leaderboard} onClose={() => setShowLeaderboard(false)} />
      )}
      {scoringMatch && (
        <ScoringModal
          match={scoringMatch}
          onScore={handleScore}
          onClose={() => setScoringMatch(null)}
          updating={!!updating}
        />
      )}
    </div>
  );
}

export default function BracketViewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-[#52B946] font-black uppercase tracking-[1.1px] bg-[#1B1B1B]">Synchronizing...</div>}>
      <BracketViewContent />
    </Suspense>
  );
}