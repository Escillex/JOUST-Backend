"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

interface User {
  sub: string;
  username?: string;
  guestName?: string;
  email?: string;
  roles?: string[];
}

interface Tournament {
  id: string;
  name: string;
  format: string;
  maxPlayers: number;
  prizePool: number | null;
  isPrivate: boolean;
  status: string;
  participants: { userId: string; user: { id: string; username?: string; guestName?: string } }[];
  venue?: string;
  date?: string | null;
  entranceFee?: number | null;
  inviteToken?: string;
}

export default function InviteTournamentPage() {
  const router = useRouter();
  const params = useParams();
  const token = params?.token as string;
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [guestName, setGuestName] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  useEffect(() => {
    if (!token) return router.push("/join_tournament");
    fetchData();
  }, [token]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [tRes, meRes] = await Promise.all([
        fetch(`${apiUrl}/tournaments/invite/${token}`, { credentials: "include" }),
        authenticatedFetch(`${apiUrl}/auth/me`),
      ]);

      if (tRes.ok) {
        setTournament(await tRes.json());
      } else {
        setMessage("Invite not found or expired.");
      }

      if (meRes.ok) {
        setUser(await meRes.json());
      } else {
        setUser(null);
      }
    } catch {
      setMessage("Unable to load invite data.");
    } finally {
      setLoading(false);
    }
  };

  const handleJoinExisting = async () => {
    if (!user || !tournament) return;
    setMessage("");
    try {
      const res = await authenticatedFetch(`${apiUrl}/tournaments/${tournament.id}/participants/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.sub }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage("You have joined the tournament!");
        fetchData();
      } else {
        setMessage(data.message || "Failed to join tournament");
      }
    } catch {
      setMessage("Failed to join tournament");
    }
  };

  const handleJoinGuest = async () => {
    if (!guestName || !tournament) return;
    setMessage("");
    try {
      const res = await fetch(`${apiUrl}/tournaments/${tournament.id}/participants/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestName }),
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        setMessage("Guest joined the tournament successfully!");
        setGuestName("");
        fetchData();
      } else {
        setMessage(data.message || "Guest join failed");
      }
    } catch {
      setMessage("Guest join failed");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#1B1B1B] text-[#52B946] font-black uppercase tracking-[1.1px]">Loading invite…</div>
    );
  }

  if (!tournament) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#1B1B1B] text-white p-6">
        <p className="text-xl font-black uppercase mb-4">Invite Not Found</p>
        <p className="text-sm text-[#838383] uppercase tracking-[1.1px] mb-6">This tournament invitation is invalid or has been removed.</p>
        <button onClick={() => router.push('/join_tournament')} className="px-6 py-3 bg-[#52B946] text-black font-black uppercase tracking-[1.1px] rounded-[10px] hover:bg-[#3E9434] transition-colors">Return to Hub</button>
      </div>
    );
  }

  const alreadyJoined = user ? tournament.participants.some((p) => p.userId === user.sub) : false;
  const canJoin = tournament.participants.length < tournament.maxPlayers && tournament.status === "OPEN";

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-white px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="rounded-[20px] p-8 shadow-lg" style={{ background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)" }}>
          <h1 className="text-4xl font-black uppercase tracking-[1.1px] mb-4">Invite to {tournament.name}</h1>
          <div className="flex flex-wrap gap-3 text-[12px] uppercase tracking-[1.1px] text-[#838383]">
            <span>{tournament.format.replace("_", " ")}</span>
            <span>{tournament.participants.length}/{tournament.maxPlayers} players</span>
            <span>{tournament.isPrivate ? "Private" : "Public"}</span>
            <span>₱{tournament.prizePool?.toLocaleString() || "0"} pool</span>
            {tournament.venue && <span>Venue: {tournament.venue}</span>}
            {tournament.date && <span>{new Date(tournament.date).toLocaleString()}</span>}
          </div>
        </div>

        <div className="rounded-[20px] p-6 shadow-lg" style={{ background: "#101010" }}>
          {message && (
            <div className={`mb-4 px-4 py-3 rounded-[10px] text-[12px] font-black uppercase tracking-[1.1px] ${message.startsWith("Failed") || message.startsWith("Invite") ? "bg-red-500/10 text-red-400" : "bg-[#52B946]/10 text-[#6FFF5E]"}`}>
              {message}
            </div>
          )}

          {alreadyJoined ? (
            <div className="space-y-4">
              <p className="text-sm uppercase text-[#838383] tracking-[1.1px]">You are already registered in this tournament.</p>
              <button onClick={() => router.push(`/join_tournament/tournament_view?id=${tournament.id}`)} className="w-full py-3 bg-[#52B946] text-black font-black uppercase rounded-[10px] tracking-[1.1px] hover:bg-[#3E9434] transition-colors">Go to Tournament</button>
            </div>
          ) : !canJoin ? (
            <p className="text-sm uppercase text-[#838383] tracking-[1.1px]">Registration is closed or the tournament is full.</p>
          ) : (
            <div className="space-y-4">
              {user ? (
                <button onClick={handleJoinExisting} className="w-full py-3 bg-[#52B946] text-black font-black uppercase rounded-[10px] tracking-[1.1px] hover:bg-[#3E9434] transition-colors">Join as {user.guestName || user.username || 'Player'}</button>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase tracking-[1.1px] text-[#838383]">Your Name</label>
                    <input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Enter a nickname" className="h-12 rounded-[10px] bg-[#1B1B1B] px-4 text-white text-sm outline-none" />
                  </div>
                  <button onClick={handleJoinGuest} className="w-full py-3 bg-[#52B946] text-black font-black uppercase rounded-[10px] tracking-[1.1px] hover:bg-[#3E9434] transition-colors">Join as Guest</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-[20px] p-6 shadow-lg" style={{ background: "#101010" }}>
          <h2 className="text-lg font-black uppercase tracking-[1.1px] mb-4">How It Works</h2>
          <p className="text-sm text-[#838383] leading-6">This invite link gives you access to join the tournament directly. If you are signed in, you can join using your account. Otherwise, register as a guest with a display name and you will be added automatically.</p>
        </div>
      </div>
    </div>
  );
}
