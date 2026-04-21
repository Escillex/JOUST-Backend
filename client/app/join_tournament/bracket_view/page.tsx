"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

type User = {
  id: string;
  username: string;
};

type Match = {
  id: string;
  player1: User | null;
  player2: User | null;
  winnerId?: string | null;
  winner?: User | null;
  status: string;
  roundId: string;
};

type Round = {
  id: string;
  roundNumber: number;
  matches: Match[];
};

type Tournament = {
  id: string;
  name: string;
  format: string;
  status: string;
  rounds: Round[];
};

type LogEntry = {
  id: string;
  timestamp: string;
  action: string;
  details?: string;
};

type LeaderboardEntry = {
  rank: number;
  userId: string;
  username: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchWinPct: number;
  omw: number;
  oomw: number;
};

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

  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);
  const [scoringMatch, setScoringMatch] = useState<Match | null>(null);
  const [scoringNote, setScoringNote] = useState("");

  useEffect(() => {
    if (tournamentId) {
      fetchTournamentData();
    } else {
      router.push("/join_tournament");
    }
  }, [tournamentId]);

  const fetchTournamentData = async () => {
    setLoading(true);
    try {
      const meRes = await authenticatedFetch(`${apiUrl}/auth/me`);
      if (meRes.ok) {
        const meData = await meRes.json();
        setIsAdmin(meData.roles?.some((r: string) => r === "ADMIN" || r === "ORGANIZER"));
      }

      const tRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}`);
      if (tRes.ok) {
        const tData = await tRes.json();
        setTournament(tData);
        addLog(`ARENA STATUS`, `Arena loaded: ${tData.name} [${tData.status}]`);
      }

      const lRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}/leaderboard`);
      if (lRes.ok) {
        const lData = await lRes.json();
        setLeaderboard(lData);
      }
    } catch (error) {
      addLog("ERROR", "Connection failed during sync");
    } finally {
      setLoading(false);
    }
  };

  const addLog = (action: string, details?: string) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toLocaleTimeString(),
      action,
      details,
    };
    setLogs((prev) => [newLog, ...prev]);
  };

  const handleScoreMatch = async (winnerId: string | null) => {
    if (!isAdmin || !scoringMatch || updating) return;

    const matchId = scoringMatch.id;
    const p1 = scoringMatch.player1;
    const p2 = scoringMatch.player2;

    let resultText = "";
    if (winnerId === p1?.id) resultText = `${p1?.username} WON`;
    else if (winnerId === p2?.id) resultText = `${p2?.username} WON`;
    else resultText = "DRAW";

    setUpdating(matchId);
    try {
      const res = await authenticatedFetch(`${apiUrl}/matches/${matchId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId: winnerId || undefined }),
      });

      if (res.ok) {
        addLog(`MATCH SCORED`, `${resultText} IN MATCH ${matchId.slice(0,4)} ${scoringNote ? `[Note: ${scoringNote}]` : ""}`);
        setScoringMatch(null);
        setScoringNote("");
        await fetchTournamentData();
      } else {
        const err = await res.json();
        addLog(`ERROR`, `Scoring failed: ${err.message}`);
      }
    } catch (error) {
      addLog("ERROR", "Connection lost during scoring");
    } finally {
      setUpdating(null);
    }
  };

  const getRoundLabel = (
    format: string,
    roundNum: number,
    totalRounds: number,
  ) => {
    if (format === "SWISS") {
      return `Round ${roundNum.toString().padStart(2, '0')}`;
    }
    if (roundNum === totalRounds) return "Finals";
    if (roundNum === totalRounds - 1) return "Semi-Finals";
    if (roundNum === totalRounds - 2) return "Quarter-Finals";
    return `Round ${roundNum.toString().padStart(2, '0')}`;
  };

  const getCurrentSwissRound = (rounds: Round[]) => {
    if (!rounds || rounds.length === 0) return 0;
    const sortedRounds = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber);
    const activeRound = sortedRounds.find(
      (round) => !round.matches.every((match) => match.status === "COMPLETED"),
    );
    return activeRound ? activeRound.roundNumber : sortedRounds[sortedRounds.length - 1].roundNumber;
  };

  const swissCurrentRound =
    tournament?.format === "SWISS" && tournament.rounds
      ? getCurrentSwissRound(tournament.rounds)
      : 0;

  const swissRoundsCompleted =
    tournament?.format === "SWISS" && tournament.rounds
      ? tournament.rounds.filter((round) =>
          round.matches.every((match) => match.status === "COMPLETED"),
        ).length
      : 0;

  if (loading && !tournament) return <div className="min-h-screen flex items-center justify-center text-[#52B946] font-black uppercase tracking-[1.1px] bg-[#1B1B1B]">Synchronizing Arena...</div>;

  const isCompleted = tournament?.status === "COMPLETED";
  const grandChampion = isCompleted && leaderboard.length > 0 ? leaderboard[0] : null;

  if (grandChampion && isCompleted) {
    const hasChampionLog = logs.some(l => l.action === "CHAMPION CROWNED");
    if (!hasChampionLog) {
      addLog("CHAMPION CROWNED", `${grandChampion.username.toUpperCase()} HAS WON THE TOURNAMENT!`);
    }
  }

  return (
    <div
      className="flex flex-col min-h-screen"
      style={{
        background:
          "linear-gradient(180deg, rgba(102,102,102,0.00) 38.15%, rgba(82,185,70,0.20) 100%), #1B1B1B",
      }}
    >
      <div className="max-w-7xl mx-auto w-full p-4 md:p-8 flex flex-col gap-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b-4 border-[#2F2F2F] pb-6">
          <div>
            <button onClick={() => router.back()} className="text-[10px] font-black text-[#838383] hover:text-[#52B946] uppercase tracking-[1.1px] mb-2 block transition-colors">← Back to Hub</button>
            <h1 className="text-3xl md:text-4xl font-black text-[#52B946] tracking-[1.1px] uppercase leading-none">
              {tournament?.name || "Tournament"} <span className="text-white opacity-20">/ Arena</span>
            </h1>
          </div>
          
          <div className="flex items-center gap-4 p-4 rounded-[20px]" style={{ background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)" }}>
            <button 
              onClick={() => setIsLeaderboardOpen(true)}
              className="px-4 py-2 bg-[#52B946] hover:bg-[#3E9434] text-white text-[10px] font-black uppercase rounded-[10px] tracking-[1.1px] transition-all"
            >
              Standings
            </button>
            <div className="h-8 w-px bg-[#2F2F2F]" />
            <div className="flex flex-col">
              <span className="text-[8px] text-[#838383] font-black uppercase tracking-[1.1px]">Format</span>
              <span className="text-[10px] font-black text-[#52B946] uppercase tracking-[1.1px]">{tournament?.format.replace("_", " ") || "N/A"}</span>
            </div>
            <div className="h-8 w-px bg-[#2F2F2F]" />
            <div className={`px-4 py-2 text-[10px] font-black uppercase rounded-[10px] tracking-[1.1px] ${isAdmin ? 'bg-red-500/10 text-red-500 border-2 border-red-500/20' : 'bg-[#101010] text-[#838383]'}`}>
              {isAdmin ? "Organizer Access" : "Viewer Mode"}
            </div>
          </div>
        </div>

        <main className="flex-1 overflow-x-auto pb-8">
          <div className="flex flex-col gap-12">
            {/* Swiss Status Card */}
            {tournament?.format === "SWISS" && (
              <section
                className="w-full rounded-[20px] p-6 shadow-lg overflow-hidden"
                style={{
                  background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
                  borderTop: "5px solid #3E9434",
                }}
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-xl font-black text-white uppercase tracking-[1.1px] mb-1">Swiss Status</h2>
                    <p className="text-sm text-[#838383] uppercase tracking-[1.1px]">Current round and pairing progress for the Swiss stage.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[11px] uppercase tracking-[1.1px] text-white font-black">
                    <div className="p-3 rounded-[10px] bg-[#101010]">
                      <span className="block text-[#838383] text-[9px]">Current Round</span>
                      <span>Round {swissCurrentRound.toString().padStart(2, '0')}</span>
                    </div>
                    <div className="p-3 rounded-[10px] bg-[#101010]">
                      <span className="block text-[#838383] text-[9px]">Rounds Complete</span>
                      <span>{swissRoundsCompleted}/{tournament.rounds.length}</span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            <div className="flex gap-16 pb-12 min-w-max items-center">
            {tournament?.rounds && tournament.rounds.length > 0 ? (
              <>
                {tournament.rounds.map((round) => (
                  <div key={round.id} className="flex flex-col gap-8">
                    <h2 className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px] border-b-2 border-[#2F2F2F] pb-2 text-center">
                      {getRoundLabel(tournament.format, round.roundNumber, tournament.rounds.length)}
                    </h2>
                    <div className="flex flex-col gap-8 justify-center h-full">
                      {round.matches.map((match) => (
                        <MatchCard 
                          key={match.id} 
                          match={match} 
                          onOpenScoring={() => isAdmin && !match.winnerId && match.player1 && match.player2 ? setScoringMatch(match) : null} 
                          isAdmin={isAdmin}
                          isUpdating={updating === match.id}
                          leaderboard={leaderboard}
                          showPoints={tournament?.format === "SWISS"}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                
                <div className="flex flex-col gap-8">
                  <h2 className="text-[10px] font-black text-[#52B946] uppercase tracking-[1.1px] border-b-2 border-[#2F2F2F] pb-2 text-center">
                    Champion
                  </h2>
                  <div className="flex flex-col justify-center h-full">
                    <div
                      className={`w-56 p-8 rounded-[20px] flex flex-col items-center justify-center gap-4 transition-all duration-500 shadow-xl ${
                        grandChampion 
                        ? 'border-t-[5px] border-[#3E9434]' 
                        : 'border-2 border-dashed border-[#2F2F2F]'
                      }`}
                      style={{
                        background: grandChampion ? "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)" : "transparent"
                      }}
                    >
                       <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center ${grandChampion ? 'border-[#52B946] text-[#52B946] shadow-[0_0_15px_rgba(82,185,70,0.3)]' : 'border-[#2F2F2F] text-[#2F2F2F]'}`}>
                         <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5M19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/></svg>
                       </div>
                       <div className="flex flex-col items-center">
                         <span className="text-[8px] text-[#838383] font-black uppercase tracking-[1.1px] mb-1">Grand Winner</span>
                         <span className={`text-sm font-black uppercase tracking-[1.1px] text-center ${grandChampion ? 'text-white' : 'text-[#2F2F2F]'}`}>
                           {grandChampion?.username || "Awaiting Final..."}
                         </span>
                       </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div
                className="flex-1 flex flex-col items-center justify-center py-24 rounded-[20px] w-full border-2 border-dashed border-[#2F2F2F]"
                style={{ background: "rgba(0,0,0,0.1)" }}
              >
                 <p className="text-xs font-black text-[#838383] uppercase tracking-[1.1px]">Tournament Bracket Pending</p>
              </div>
            )}
          </div>
          </div>
        </main>

        <footer className="mt-8">
          <div
            className="rounded-[20px] p-6 shadow-lg"
            style={{
              background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
              borderTop: "5px solid #3E9434",
            }}
          >
            <h3 className="text-xs font-black text-[#52B946] uppercase tracking-[1.1px] mb-4 border-b-2 border-[#2F2F2F] pb-2">Arena Log</h3>
            <div className="bg-[#101010] rounded-[10px] p-4 h-48 overflow-y-auto font-mono text-[10px] border border-[#2F2F2F]">
              {logs.length === 0 ? (
                <p className="text-[#2F2F2F] uppercase font-black tracking-[1.1px]">Awaiting activity...</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {logs.map((log) => (
                    <div key={log.id} className="flex flex-col border-b border-[#2F2F2F] pb-2 last:border-0">
                      <div className="flex gap-4">
                        <span className="text-[#838383] shrink-0 font-black">[{log.timestamp}]</span>
                        <span className="text-[#52B946] font-black uppercase tracking-[1.1px]">{log.action}</span>
                      </div>
                      {log.details && <div className="text-white opacity-60 mt-1 ml-14 tracking-wide">{log.details}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </footer>
      </div>

      {/* Leaderboard Modal */}
      {isLeaderboardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div 
            className="w-full max-w-4xl rounded-[30px] p-8 shadow-2xl relative animate-in fade-in zoom-in duration-300"
            style={{ background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)", border: "2px solid #2F2F2F" }}
          >
            <button 
              onClick={() => setIsLeaderboardOpen(false)}
              className="absolute top-6 right-6 text-[#838383] hover:text-white text-2xl font-black uppercase tracking-[1.1px]"
            >
              ✕
            </button>
            <h2 className="text-3xl font-black text-[#52B946] uppercase tracking-[2px] mb-8 border-b-4 border-[#2F2F2F] pb-4">Tournament Standings</h2>
            
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[12px] font-black text-[#838383] uppercase tracking-[1.1px] border-b-2 border-[#2F2F2F]">
                    <th className="px-6 py-4">Rank</th>
                    <th className="px-6 py-4">Player</th>
                    <th className="px-6 py-4 text-center">Points</th>
                    <th className="px-6 py-4 text-center">W-D-L</th>
                    <th className="px-6 py-4 text-center">Winrate</th>
                    <th className="px-6 py-4 text-center">OMW%</th>
                    <th className="px-6 py-4 text-center">OOMW%</th>
                  </tr>
                </thead>
                <tbody className="text-[14px] font-bold text-white uppercase tracking-[1.1px]">
                  {leaderboard.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-20 text-[#838383]">No data available yet...</td></tr>
                  ) : (
                    leaderboard.map((entry) => (
                      <tr key={entry.userId} className="border-b border-[#2F2F2F] hover:bg-white/5 transition-colors">
                        <td className="px-6 py-5 text-[#52B946]">#{entry.rank.toString().padStart(2, '0')}</td>
                        <td className="px-6 py-5 font-black">{entry.username}</td>
                        <td className="px-6 py-5 text-center text-[#6FFF5E] font-black">{entry.points}</td>
                        <td className="px-6 py-5 text-center text-[#838383]">{entry.wins}-{entry.draws || 0}-{entry.losses}</td>
                        <td className="px-6 py-5 text-center text-[#838383]">{(entry.matchWinPct * 100).toFixed(1)}%</td>
                        <td className="px-6 py-5 text-center text-[#838383]">{(entry.omw * 100).toFixed(1)}%</td>
                        <td className="px-6 py-5 text-center text-[#838383]">{(entry.oomw * 100).toFixed(1)}%</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Scoring Modal */}
      {scoringMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div 
            className="w-full max-w-md rounded-[30px] p-8 shadow-2xl relative animate-in fade-in zoom-in duration-300"
            style={{ background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)", border: "2px solid #52B946" }}
          >
            <button 
              onClick={() => { setScoringMatch(null); setScoringNote(""); }}
              className="absolute top-6 right-6 text-[#838383] hover:text-white text-xl font-black"
            >
              ✕
            </button>
            <h2 className="text-xl font-black text-white uppercase tracking-[1.1px] mb-2">Score Match</h2>
            <p className="text-[10px] text-[#838383] uppercase tracking-[1.1px] mb-8">Select the outcome of the battle below.</p>

            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => handleScoreMatch(scoringMatch.player1?.id || null)}
                  className="w-full py-4 bg-[#101010] border-2 border-[#2F2F2F] hover:border-[#52B946] text-white rounded-[15px] transition-all flex justify-between items-center px-6 group"
                >
                  <span className="font-black uppercase tracking-[1.1px]">{scoringMatch.player1?.username}</span>
                  <span className="text-[10px] font-black text-[#52B946] opacity-0 group-hover:opacity-100 uppercase">Win</span>
                </button>

                <button 
                  onClick={() => handleScoreMatch(null)}
                  className="w-full py-4 bg-[#101010] border-2 border-[#2F2F2F] hover:border-[#838383] text-[#838383] rounded-[15px] transition-all flex justify-between items-center px-6 group"
                >
                  <span className="font-black uppercase tracking-[1.1px]">Draw</span>
                  <span className="text-[10px] font-black opacity-0 group-hover:opacity-100 uppercase">Stalemate</span>
                </button>

                <button 
                  onClick={() => handleScoreMatch(scoringMatch.player2?.id || null)}
                  className="w-full py-4 bg-[#101010] border-2 border-[#2F2F2F] hover:border-[#52B946] text-white rounded-[15px] transition-all flex justify-between items-center px-6 group"
                >
                  <span className="font-black uppercase tracking-[1.1px]">{scoringMatch.player2?.username}</span>
                  <span className="text-[10px] font-black text-[#52B946] opacity-0 group-hover:opacity-100 uppercase">Win</span>
                </button>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px]">Change Note</label>
                <textarea 
                  value={scoringNote}
                  onChange={(e) => setScoringNote(e.target.value)}
                  placeholder="e.g. 2-0 Victory"
                  className="w-full h-24 bg-[#101010] rounded-[15px] p-4 text-xs text-white outline-none border-2 border-[#2F2F2F] focus:border-[#52B946] transition-all"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MatchCard({ 
  match, 
  onOpenScoring, 
  isAdmin, 
  isUpdating,
  leaderboard,
  showPoints
}: { 
  match: Match, 
  onOpenScoring: () => void, 
  isAdmin: boolean,
  isUpdating: boolean,
  leaderboard: LeaderboardEntry[],
  showPoints?: boolean
}) {
  const isByeMatch = match.player1 !== null && match.player2 === null;
  const p1Stats = leaderboard.find(l => l.userId === match.player1?.id);
  const p2Stats = leaderboard.find(l => l.userId === match.player2?.id);
  
  const canScore = isAdmin && !match.winnerId && match.player1 && match.player2;

  return (
    <div
      onClick={onOpenScoring}
      className={`w-52 flex flex-col rounded-[15px] shadow-lg transition-all overflow-hidden relative group ${
        isUpdating ? "opacity-50 pointer-events-none" : ""
      } ${canScore ? "cursor-pointer hover:border-[#52B946] border-2 border-transparent" : "border-2 border-[#2F2F2F]"}`}
      style={{
        background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
      }}
    >
      <ParticipantRow
        participant={match.player1}
        isWinner={match.winnerId === match.player1?.id}
        points={showPoints ? p1Stats?.points : undefined}
      />
      <div className="h-px bg-[#2F2F2F] w-full" />
      <ParticipantRow
        participant={match.player2}
        isWinner={match.winnerId === match.player2?.id}
        points={showPoints ? p2Stats?.points : undefined}
        isBye={isByeMatch}
      />
      {canScore && (
        <div className="absolute inset-0 bg-[#52B946]/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="text-[10px] font-black text-[#52B946] uppercase tracking-[2px] bg-[#101010] px-3 py-1 rounded-full border border-[#52B946]">Score Match</span>
        </div>
      )}
    </div>
  );
}

function ParticipantRow({ 
  participant, 
  isWinner, 
  isBye,
  points,
}: { 
  participant: User | null, 
  isWinner: boolean, 
  isBye?: boolean,
  points?: number,
}) {
  return (
    <div
      className={`px-4 py-3 flex justify-between items-center transition-all ${isWinner ? "bg-[#52B946]/10" : ""}`}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        {isWinner && <div className="w-1.5 h-1.5 bg-[#52B946] rounded-full shrink-0 shadow-[0_0_8px_#52B946]" />}
        <div className="flex flex-col">
          <span className={`text-[11px] font-black uppercase tracking-[1.1px] truncate ${participant ? (isWinner ? "text-[#52B946]" : "text-white") : "text-[#2F2F2F]"}`}>
            {participant?.username || (isBye ? "BYE" : "TBD")}
          </span>
          {points !== undefined && participant && (
            <span className="text-[8px] text-[#838383] font-black uppercase tracking-[1.1px]">
              {points} PTS
            </span>
          )}
        </div>
      </div>
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
