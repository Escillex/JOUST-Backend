"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

interface Tournament {
  id: string;
  name: string;
  format: string;
  maxPlayers: number;
  prizePool: number | null;
  isPrivate: boolean;
  status: string;
  createdAt: string;
  createdBy?: {
    username: string;
  };
  rounds?: {
    matches: {
      winner?: {
        username: string;
      };
    }[];
  }[];
}

interface User {
  sub: string;
  email: string;
  roles: string[];
  username: string;
}

export default function TournamentPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [format, setFormat] = useState("SINGLE_ELIMINATION");
  const [maxPlayers, setMaxPlayers] = useState(16);
  const [prizePool, setPrizePool] = useState<number | "">("");
  const [isPrivate, setIsPrivate] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const userRes = await authenticatedFetch(`${apiUrl}/auth/me`);
      if (userRes.ok) {
        const userData = await userRes.json();
        const roles = userData.roles || [];
        
        // Any logged-in user can access the Hub
        setUser({
          ...userData,
          roles: roles
        });
      } else {
        router.push("/");
        return;
      }

      const tourneyRes = await authenticatedFetch(`${apiUrl}/tournaments`);
      if (tourneyRes.ok) {
        const tourneyData = await tourneyRes.json();
        setTournaments(tourneyData);
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem("token");
    router.push("/");
  };

  const handleCreateTournament = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    if (!user) return;
    try {
      const response = await authenticatedFetch(`${apiUrl}/tournaments/createtournament`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          format,
          maxPlayers: Number(maxPlayers),
          prizePool: prizePool === "" ? null : Number(prizePool),
          isPrivate,
          createdById: user.sub,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setMessage("Tournament created successfully!");
        setShowCreateForm(false);
        setName("");
        setFormat("SINGLE_ELIMINATION");
        setMaxPlayers(16);
        setPrizePool("");
        setIsPrivate(false);
        fetchData();
      } else {
        setMessage(`Error: ${data.message || "Failed to create tournament"}`);
      }
    } catch (error) {
      setMessage("Error: Failed to connect to server");
    }
  };

  const handleCompleteTournament = async (tournamentId: string) => {
    try {
      const response = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}/complete`, {
        method: "PATCH",
      });
      const data = await response.json();
      if (response.ok) {
        setMessage("Tournament completed and guests cleaned up!");
        fetchData();
      } else {
        setMessage(`Error: ${data.message || "Failed to complete tournament"}`);
      }
    } catch (error) {
      setMessage("Error: Failed to connect to server");
    }
  };

  const isOrganizerOrAdmin = user?.roles?.some(role => role === "ADMIN" || role === "ORGANIZER") || false;

  const getChampionName = (t: Tournament) => {
    if (t.status !== "COMPLETED" || !t.rounds || t.rounds.length === 0) return null;
    const lastRound = t.rounds[0]; // Backend returns rounds ordered by roundNumber DESC, taken 1
    const lastMatch = lastRound.matches[0];
    return lastMatch?.winner?.username;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[#52B946] bg-[#1B1B1B]">
        <div className="text-xl font-black uppercase tracking-[1.1px]">Loading Arena...</div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(180deg, rgba(102,102,102,0.00) 38.15%, rgba(82,185,70,0.20) 100%), #1B1B1B",
      }}
    >
      <div className="max-w-6xl mx-auto w-full p-4 md:p-8 flex flex-col gap-8">
        {/* Header */}
        <div className="flex justify-between items-center border-b-4 border-[#2F2F2F] pb-6">
          <div>
            <h1 className="text-4xl font-black text-[#52B946] tracking-[1.1px] uppercase">
              Tournament Hub
            </h1>
            <div className="flex items-center gap-4 mt-1">
              <p className="text-[#838383] text-sm tracking-[1.1px] uppercase">
                {user ? `Logged in as ${user.username ?? user.email.split("@")[0]} · ${user.roles?.[0] ?? "PLAYER"}` : "Guest Mode"}
              </p>
              <button
                onClick={handleSignOut}
                className="text-xs text-red-500 hover:text-red-400 font-bold uppercase tracking-[1.1px] underline transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
          <div className="flex gap-4">
            {user?.roles?.includes("ADMIN") && (
              <button
                onClick={() => router.push("/join_tournament/handle_organizer")}
                className="px-8 h-[50px] rounded-[10px] bg-purple-600 hover:bg-purple-700 flex items-center justify-center transition-colors font-semibold text-lg tracking-[1.1px] uppercase text-white"
              >
                Manage Organizers
              </button>
            )}
            {isOrganizerOrAdmin && (
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className={`px-8 h-[50px] rounded-[10px] flex items-center justify-center transition-colors font-semibold text-lg tracking-[1.1px] uppercase text-white ${
                  showCreateForm ? "bg-[#2F2F2F]" : "bg-[#52B946] hover:bg-[#3E9434]"
                }`}
              >
                {showCreateForm ? "Cancel" : "Create Tournament"}
              </button>
            )}
          </div>
        </div>

        {/* Create Form Section */}
        {showCreateForm && (
          <div
            className="w-full rounded-[20px] p-8 flex flex-col gap-6 shadow-lg"
            style={{
              background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
              borderTop: "5px solid #3E9434",
            }}
          >
            <h2 className="text-2xl font-black uppercase text-white tracking-[1.1px]">New Tournament</h2>
            <form onSubmit={handleCreateTournament} className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label className="text-white text-[15px] tracking-[1.1px] uppercase">Tournament Name</label>
                <div
                  className="w-full h-[50px] rounded-[5px] flex items-center px-[15px]"
                  style={{ background: "#101010" }}
                >
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Pro League 2024"
                    className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] uppercase outline-none placeholder:text-[#838383]"
                    required
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-white text-[15px] tracking-[1.1px] uppercase">Format</label>
                <div
                  className="w-full h-[50px] rounded-[5px] flex items-center px-[15px]"
                  style={{ background: "#101010" }}
                >
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] uppercase outline-none appearance-none cursor-pointer"
                  >
                    <option value="SINGLE_ELIMINATION" className="bg-[#101010]">Single Elimination</option>
                    <option value="DOUBLE_ELIMINATION" className="bg-[#101010]">Double Elimination</option>
                    <option value="SWISS" className="bg-[#101010]">Swiss</option>
                    <option value="ROUND_ROBIN" className="bg-[#101010]">Round Robin</option>
                    <option value="FREE_FOR_ALL" className="bg-[#101010]">Free For All</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-white text-[15px] tracking-[1.1px] uppercase">Max Players</label>
                <div
                  className="w-full h-[50px] rounded-[5px] flex items-center px-[15px]"
                  style={{ background: "#101010" }}
                >
                  <input
                    type="number"
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(Number(e.target.value))}
                    min="2"
                    max="128"
                    className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] uppercase outline-none"
                    required
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-white text-[15px] tracking-[1.1px] uppercase">Prize Pool (₱)</label>
                <div
                  className="w-full h-[50px] rounded-[5px] flex items-center px-[15px]"
                  style={{ background: "#101010" }}
                >
                  <input
                    type="number"
                    value={prizePool}
                    onChange={(e) => setPrizePool(e.target.value === "" ? "" : Number(e.target.value))}
                    placeholder="0.00 (Optional)"
                    className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] uppercase outline-none placeholder:text-[#838383]"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 md:col-span-2">
                <input
                  type="checkbox"
                  id="isPrivate"
                  checked={isPrivate}
                  onChange={(e) => setIsPrivate(e.target.checked)}
                  className="w-6 h-6 accent-[#52B946] bg-[#101010] border-none rounded-[5px]"
                />
                <label htmlFor="isPrivate" className="text-white text-[15px] tracking-[1.1px] uppercase cursor-pointer">
                  Private Tournament
                </label>
              </div>

              <div className="md:col-span-2 flex flex-col gap-4">
                {message && (
                  <div className={`text-sm font-bold tracking-[1.1px] uppercase ${message.startsWith("Error") ? "text-red-500" : "text-[#6FFF5E]"}`}>
                    {message}
                  </div>
                )}
                <div className="flex justify-center">
                  <button
                    type="submit"
                    className="w-full sm:w-[280px] h-[60px] rounded-[20px] bg-[#52B946] hover:bg-[#3E9434] transition-colors flex items-center justify-center font-black text-[18px] sm:text-[20px] tracking-[1.1px] uppercase text-white"
                  >
                    Initialize Arena
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* Tournaments List */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tournaments.length === 0 ? (
            <div
              className="col-span-full py-20 text-center rounded-[20px]"
              style={{
                background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
                border: "2px dashed #2F2F2F",
              }}
            >
              <p className="text-[#838383] uppercase font-black tracking-[1.1px]">No Tournaments Active</p>
            </div>
          ) : (
            tournaments.map((t) => {
              const champion = getChampionName(t);
              const isActive = t.status !== 'COMPLETED';
              return (
                <div
                  key={t.id}
                  className="rounded-[20px] p-6 flex flex-col gap-4 shadow-lg transition-all hover:translate-y-[-4px]"
                  style={{
                    background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
                    borderTop: `5px solid ${isActive ? '#52B946' : '#838383'}`,
                  }}
                >
                  <div className="flex justify-between items-start">
                    <h3 className="text-xl font-black uppercase text-white tracking-[1.1px] truncate pr-2">{t.name}</h3>
                    <span
                      className={`px-3 py-1 rounded-[10px] text-[10px] font-black tracking-[1.1px] uppercase ${
                        isActive ? 'bg-[#52B946] text-white' : 'bg-[#2F2F2F] text-[#838383]'
                      }`}
                    >
                      {t.status}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-y-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase text-[#838383] font-black tracking-[1.1px]">Format</span>
                      <span className="text-sm text-white font-semibold uppercase">{t.format.replace("_", " ")}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase text-[#838383] font-black tracking-[1.1px]">Players</span>
                      <span className="text-sm text-white font-semibold uppercase">{t.maxPlayers} MAX</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase text-[#838383] font-black tracking-[1.1px]">Prize Pool</span>
                      <span className="text-sm text-[#6FFF5E] font-black tracking-[1.1px]">
                        {t.prizePool ? `₱${t.prizePool.toLocaleString()}` : "NO PRIZE"}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase text-[#838383] font-black tracking-[1.1px]">Access</span>
                      <span className="text-sm text-white font-semibold uppercase">{t.isPrivate ? "PRIVATE" : "PUBLIC"}</span>
                    </div>
                  </div>

                  {t.status === "COMPLETED" && champion && (
                    <div className="mt-2 p-3 bg-[#52B946]/10 border border-[#52B946]/30 rounded-[10px] flex flex-col items-center">
                      <span className="text-[9px] font-black text-[#52B946] uppercase tracking-[1.1px]">Grand Champion</span>
                      <span className="text-lg font-black text-white uppercase tracking-[1.1px]">{champion}</span>
                    </div>
                  )}
                  
                  <div className="mt-4 flex flex-col gap-2">
                    {isOrganizerOrAdmin && t.status === "COMPLETED" && (
                      <button
                        onClick={() => handleCompleteTournament(t.id)}
                        className="w-full py-2 border-2 border-red-500 text-red-500 text-[10px] font-black tracking-[1.1px] uppercase hover:bg-red-500 hover:text-white transition-all rounded-[10px]"
                      >
                        Complete Tournament
                      </button>
                    )}

                    <button 
                      onClick={() => router.push(`/join_tournament/tournament_view?id=${t.id}`)}
                      className="w-full h-[45px] rounded-[10px] bg-[#52B946] hover:bg-[#3E9434] text-white text-[12px] font-black tracking-[1.1px] uppercase transition-all"
                    >
                      {t.status === "COMPLETED" ? "View Results" : "Enter Arena"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
