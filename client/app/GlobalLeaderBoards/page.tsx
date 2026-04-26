"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

interface LeaderboardEntry {
  userId: string;
  username: string;
  points: number;
  tournamentsPlayed: number;
  wins: number;
  losses: number;
  rank: number;
}

export default function GlobalLeaderBoardsPage() {
  const router = useRouter();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      setError("");

      try {
        const res = await authenticatedFetch(`${apiUrl}/tournaments/leaderboard/global`);
        if (!res.ok) {
          throw new Error(`Failed to load leaderboard (${res.status})`);
        }
        setLeaderboard(await res.json());
      } catch (err) {
        setError("Unable to load global leaderboard.");
      } finally {
        setLoading(false);
      }
    };

    fetchLeaderboard();
  }, [apiUrl]);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "linear-gradient(180deg, rgba(102,102,102,0) 38.15%, rgba(82,185,70,0.2) 100%), #1B1B1B" }}>
      <div className="max-w-6xl mx-auto w-full p-4 md:p-8 flex flex-col gap-8">
        <div className="flex justify-between items-center border-b-4 border-[#2F2F2F] pb-6">
          <div>
            <h1 className="text-4xl font-black text-[#52B946] uppercase tracking-[1.1px]">Global Leaderboards</h1>
            <p className="text-[#838383] text-sm tracking-[1.1px] uppercase mt-2">Top performers across all tournaments</p>
          <button onClick={() => router.push("/")} className="px-4 py-1 rounded-[10px] border-2 border-[#52B946] text-[#52B946] hover:bg-[#52B946] hover:text-white transition-all font-bold text-xs uppercase tracking-[1.1px]">Home</button>
          </div>
          
          <button
            onClick={() => router.push("/join_tournament")}
            className="px-4 py-2 rounded-[10px] bg-[#52B946] hover:bg-[#3E9434] text-white uppercase tracking-[1.1px] font-bold"
          >
            Back to Tournament Hub
          </button>
        </div>

        <div className="rounded-[20px] p-6 shadow-lg" style={{ background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)" }}>
          {loading ? (
            <p className="text-[#838383] uppercase text-sm tracking-[1.1px]">Loading leaderboard...</p>
          ) : error ? (
            <p className="text-red-500 uppercase text-sm tracking-[1.1px]">{error}</p>
          ) : leaderboard.length === 0 ? (
            <p className="text-[#838383] uppercase text-sm tracking-[1.1px]">No global leaderboard data available yet.</p>
          ) : (
            <div className="grid gap-3">
              {leaderboard.slice(0, 10).map((entry) => (
                <div key={entry.userId} className="flex items-center justify-between px-4 py-3 rounded-[10px]" style={{ background: "#101010" }}>
                  <div>
                    <p className="text-[11px] text-[#838383] uppercase tracking-[1.1px]">#{entry.rank} {entry.username}</p>
                    <p className="text-sm text-white font-black uppercase tracking-[1.1px]">
                      {entry.points} pts · {entry.tournamentsPlayed} tournaments
                    </p>
                  </div>
                  <span className="text-[10px] text-[#52B946] font-black uppercase tracking-[1.1px]">
                    {entry.wins}-{entry.losses}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}