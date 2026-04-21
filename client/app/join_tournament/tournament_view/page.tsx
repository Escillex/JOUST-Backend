"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authenticatedFetch } from "@/app/utils/api";

interface User {
  id: string;
  sub: string;
  username: string;
  email: string;
  roles: string[];
}

interface Participant {
  id: string;
  userId: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

interface Tournament {
  id: string;
  name: string;
  format: string;
  maxPlayers: number;
  prizePool: number | null;
  isPrivate: boolean;
  status: string;
  createdById: string;
  participants: Participant[];
}

function TournamentViewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tournamentId = searchParams.get("id");

  const [user, setUser] = useState<User | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [allUsers, setAllUsers] = useState<{ id: string; username: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editFormat, setEditFormat] = useState("");
  const [editMaxPlayers, setEditMaxPlayers] = useState(0);
  const [editPrizePool, setEditPrizePool] = useState<number | "">("");
  const [editIsPrivate, setEditIsPrivate] = useState(false);

  const [guestUsername, setGuestUsername] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  useEffect(() => {
    if (tournamentId) {
      fetchData();
    } else {
      router.push("/join_tournament");
    }
  }, [tournamentId]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const meRes = await authenticatedFetch(`${apiUrl}/auth/me`);
      if (meRes.ok) {
        const meData = await meRes.json();
        setUser({ ...meData, roles: meData.roles || [] });
        if (meData.roles?.some((r: string) => r === "ADMIN" || r === "ORGANIZER")) {
          const usersRes = await authenticatedFetch(`${apiUrl}/auth/users`);
          if (usersRes.ok) setAllUsers(await usersRes.json());
        }
      } else {
        router.push("/");
        return;
      }

      const tRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}`);
      if (tRes.ok) {
        const tData = await tRes.json();
        setTournament(tData);
        setEditName(tData.name);
        setEditFormat(tData.format);
        setEditMaxPlayers(tData.maxPlayers);
        setEditPrizePool(tData.prizePool || "");
        setEditIsPrivate(tData.isPrivate || false);
      } else {
        setMessage("Tournament not found");
      }
    } catch (error) {
      setMessage("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateTournament = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          format: editFormat,
          maxPlayers: Number(editMaxPlayers),
          prizePool: editPrizePool === "" ? null : Number(editPrizePool),
          isPrivate: editIsPrivate,
        }),
      });
      if (res.ok) {
        setMessage("Updated!");
        setIsEditing(false);
        fetchData();
      }
    } catch (error) {
      setMessage("Update failed");
    }
  };

  const handleJoin = async (userId: string) => {
    try {
      const res = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}/participants/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        setMessage("Joined!");
        fetchData();
        return true;
      } else {
        const err = await res.json();
        if (err.message?.includes("full")) {
          alert(err.message);
        }
        setMessage(err.message || "Join failed");
        return false;
      }
    } catch (error) {
      setMessage("Join failed");
      return false;
    }
  };

  const handleAddGuest = async () => {
    if (!guestUsername) return;
    
    if (tournament && tournament.participants.length >= tournament.maxPlayers) {
      alert(`Tournament is full (${tournament.maxPlayers} players max)`);
      return;
    }

    try {
      const guestRes = await authenticatedFetch(`${apiUrl}/auth/createguest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: guestUsername }),
      });
      if (guestRes.ok) {
        const guest = await guestRes.json();
        const joined = await handleJoin(guest.id);
        if (joined) {
          setGuestUsername("");
        }
      } else {
        const err = await guestRes.json();
        setMessage(err.message || "Guest creation failed");
      }
    } catch (error) {
      setMessage("Guest addition failed");
    }
  };

  const handleFillWithGuests = async () => {
    if (!tournament) return;
    const remaining = tournament.maxPlayers - tournament.participants.length;
    if (remaining <= 0) {
      alert("Tournament is already full!");
      return;
    }

    if (!confirm(`Fill the remaining ${remaining} slots with guests?`)) return;

    setLoading(true);
    setMessage(`Summoning ${remaining} guests...`);
    
    let successCount = 0;
    try {
      for (let i = 0; i < remaining; i++) {
        const guestName = `Guest ${tournament.participants.length + i + 1}`;
        const guestRes = await authenticatedFetch(`${apiUrl}/auth/createguest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: guestName }),
        });
        
        if (guestRes.ok) {
          const guest = await guestRes.json();
          const joinedRes = await authenticatedFetch(`${apiUrl}/tournaments/${tournamentId}/participants/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: guest.id }),
          });
          if (joinedRes.ok) successCount++;
        }
      }
      setMessage(`Successfully added ${successCount} guests!`);
      await fetchData();
    } catch (error) {
      setMessage("Error during bulk addition");
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const handleStartTournament = async () => {
    if (!confirm("Start tournament?")) return;
    try {
      const res = await authenticatedFetch(`${apiUrl}/tournaments/starttournament/${tournamentId}`, { method: "POST" });
      if (res.ok) {
        setMessage("Tournament started!");
        fetchData();
      }
    } catch (error) {
      setMessage("Start failed");
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem("token");
    router.push("/");
  };

  const isOrganizerOrAdmin = user?.roles?.some(role => role === "ADMIN" || role === "ORGANIZER") || false;

  if (loading) return <div className="min-h-screen flex items-center justify-center text-[#52B946] font-black uppercase tracking-[1.1px] bg-[#1B1B1B]">Synchronizing...</div>;
  if (!tournament) return <div className="min-h-screen flex items-center justify-center text-white p-8 bg-[#1B1B1B]">Arena Not Found</div>;

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(180deg, rgba(102,102,102,0.00) 38.15%, rgba(82,185,70,0.20) 100%), #1B1B1B",
      }}
    >
      <div className="max-w-6xl mx-auto w-full p-2 md:p-6 flex flex-col gap-4">
        {/* Compact Utility Bar */}
        <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-[1.1px] text-[#838383] border-b-2 border-[#2F2F2F] pb-2">
           <button onClick={() => router.push("/join_tournament")} className="hover:text-[#52B946] transition-colors">← Hub</button>
           <div className="flex gap-4">
             <span className="text-[#52B946]">{user?.username || "WARRIOR"}</span>
             <button onClick={handleSignOut} className="hover:text-red-500 transition-colors">Exit</button>
           </div>
        </div>

        {/* Hero Header */}
        <div
          className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 p-8 rounded-[20px] shadow-lg"
          style={{
            background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
            borderTop: "5px solid #3E9434",
          }}
        >
          <div>
            <h1 className="text-4xl md:text-5xl font-black text-white tracking-[1.1px] uppercase leading-none">
              {tournament.name}
            </h1>
            <div className="flex items-center gap-3 mt-4">
              <span className="bg-[#52B946] text-white px-3 py-1 rounded-[10px] text-[10px] font-black uppercase tracking-[1.1px]">
                {tournament.status}
              </span>
              <span className="text-[#838383] text-xs font-bold uppercase tracking-[1.1px]">
                ₱{tournament.prizePool?.toLocaleString() || "0"} Pool • {tournament.format.replace("_", " ")}
              </span>
            </div>
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <button 
              onClick={() => router.push(`/join_tournament/bracket_view?id=${tournamentId}`)}
              className="flex-1 md:px-8 h-[50px] bg-transparent border-2 border-[#52B946] text-[#52B946] rounded-[10px] text-[12px] font-black uppercase tracking-[1.1px] hover:bg-[#52B946] hover:text-white transition-all"
            >
              Brackets
            </button>
            {isOrganizerOrAdmin && tournament.status === "OPEN" && (
              <button 
                onClick={handleStartTournament}
                className="flex-1 md:px-8 h-[50px] bg-[#52B946] text-white rounded-[10px] text-[12px] font-black uppercase tracking-[1.1px] hover:bg-[#3E9434] transition-all"
              >
                Start
              </button>
            )}
          </div>
        </div>

        {message && (
          <div className="px-4 py-2 bg-[#52B946]/10 border border-[#52B946]/30 text-[#6FFF5E] text-[10px] font-black uppercase text-center rounded-[5px] tracking-[1.1px]">
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Main Content: Participants */}
          <div
            className="lg:col-span-8 rounded-[20px] p-6 shadow-lg"
            style={{
              background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
            }}
          >
            <div className="flex justify-between items-center mb-6 border-b-2 border-[#2F2F2F] pb-4">
              <h2 className="text-xl font-black uppercase text-white tracking-[1.1px]">
                Arena Roster <span className="text-[#838383] ml-1">[{tournament.participants.length}/{tournament.maxPlayers}]</span>
              </h2>
              {!isOrganizerOrAdmin && tournament.status === "OPEN" && !tournament.participants.some(p => p.userId === user?.sub) && (
                <button
                  onClick={() => user && handleJoin(user.sub)}
                  className="text-sm font-black text-[#52B946] hover:text-[#3E9434] tracking-[1.1px] uppercase underline"
                >
                  Join Now
                </button>
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {tournament.participants.length === 0 ? (
                <p className="col-span-full text-sm text-[#838383] font-black uppercase text-center py-12 tracking-[1.1px]">No combatants registered...</p>
              ) : (
                tournament.participants.map((p, idx) => (
                  <div key={p.id} className="flex items-center justify-between px-4 py-3 rounded-[10px]" style={{ background: "#101010" }}>
                    <div className="flex items-center gap-3">
                      <span className="text-[#52B946] font-black text-xs w-5">{(idx + 1).toString().padStart(2, '0')}</span>
                      <span className="text-sm font-bold text-white uppercase tracking-[1.1px] truncate max-w-[150px]">{p.user.username}</span>
                    </div>
                    <span className="text-[10px] text-[#838383] font-black tracking-[1.1px]">#{p.user.id.slice(0,6).toUpperCase()}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Sidebar: Settings & Management */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            {/* Tournament Settings Card */}
            <div
              className="rounded-[20px] p-6 shadow-lg"
              style={{
                background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
              }}
            >
              <div className="flex justify-between items-center mb-4 border-b-2 border-[#2F2F2F] pb-3">
                <h2 className="text-lg font-black uppercase text-white tracking-[1.1px]">Specs</h2>
                {isOrganizerOrAdmin && (
                  <button onClick={() => setIsEditing(!isEditing)} className="text-[10px] font-black uppercase text-[#838383] hover:text-[#52B946] underline tracking-[1.1px]">
                    {isEditing ? "Cancel" : "Edit"}
                  </button>
                )}
              </div>

              {isEditing ? (
                <form onSubmit={handleUpdateTournament} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px]">Name</label>
                    <div className="h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                      <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full bg-transparent text-xs text-[#838383] outline-none" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px]">Format</label>
                    <div className="h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                      <select value={editFormat} onChange={e => setEditFormat(e.target.value)} className="w-full bg-transparent text-xs text-[#838383] outline-none appearance-none">
                        <option value="SINGLE_ELIMINATION" className="bg-[#101010]">Single Elimination</option>
                        <option value="SWISS" className="bg-[#101010]">Swiss</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px]">Max</label>
                      <div className="h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                        <input type="number" value={editMaxPlayers} onChange={e => setEditMaxPlayers(Number(e.target.value))} className="w-full bg-transparent text-xs text-[#838383] outline-none" />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-black text-[#838383] uppercase tracking-[1.1px]">Prize</label>
                      <div className="h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                        <input type="number" value={editPrizePool} onChange={e => setEditPrizePool(e.target.value === "" ? "" : Number(e.target.value))} className="w-full bg-transparent text-xs text-[#838383] outline-none" />
                      </div>
                    </div>
                  </div>
                  <button type="submit" className="h-[45px] bg-[#52B946] text-white font-black text-[12px] uppercase rounded-[10px] tracking-[1.1px] hover:bg-[#3E9434]">Update</button>
                </form>
              ) : (
                <div className="grid grid-cols-2 gap-y-4 gap-x-2 text-[12px] font-black uppercase tracking-[1.1px]">
                  <div className="flex flex-col"><span className="text-[#838383] text-[9px] mb-1">Format</span> <span className="text-white">{tournament.format.replace("_"," ")}</span></div>
                  <div className="flex flex-col"><span className="text-[#838383] text-[9px] mb-1">Players</span> <span className="text-white">{tournament.maxPlayers}</span></div>
                  <div className="flex flex-col"><span className="text-[#838383] text-[9px] mb-1">Access</span> <span className="text-white">{tournament.isPrivate ? "Private" : "Public"}</span></div>
                  <div className="flex flex-col"><span className="text-[#838383] text-[9px] mb-1">Status</span> <span className="text-[#52B946]">{tournament.status}</span></div>
                </div>
              )}
            </div>

            {/* Admin Controls */}
            {isOrganizerOrAdmin && tournament.status === "OPEN" && (
              <div
                className="rounded-[20px] p-6 shadow-lg"
                style={{
                  background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
                }}
              >
                <h2 className="text-lg font-black uppercase text-white tracking-[1.1px] mb-4 border-b-2 border-[#2F2F2F] pb-3">Manage</h2>
                <div className="flex flex-col gap-6">
                  <div>
                    <span className="text-[10px] text-[#838383] block mb-2 font-black uppercase tracking-[1.1px]">Summon Guest</span>
                    <div className="flex gap-2">
                      <div className="flex-1 h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                        <input placeholder="Name" value={guestUsername} onChange={e => setGuestUsername(e.target.value)} className="w-full bg-transparent text-xs text-[#838383] outline-none" />
                      </div>
                      <button onClick={handleAddGuest} className="w-[40px] h-[40px] rounded-[5px] bg-transparent border-2 border-[#52B946] text-[#52B946] font-black text-xl hover:bg-[#52B946] hover:text-white transition-all">+</button>
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#838383] block mb-2 font-black uppercase tracking-[1.1px]">Invite User</span>
                    <div className="flex flex-col gap-2">
                      <div className="h-[40px] rounded-[5px] flex items-center px-3" style={{ background: "#101010" }}>
                        <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} className="w-full bg-transparent text-xs text-[#838383] outline-none appearance-none">
                          <option value="" className="bg-[#101010]">Select Player</option>
                          {allUsers.filter(u => !tournament.participants.some(p => p.userId === u.id)).map(u => (
                            <option key={u.id} value={u.id} className="bg-[#101010]">{u.username}</option>
                          ))}
                        </select>
                      </div>
                      <button onClick={() => selectedUserId && handleJoin(selectedUserId)} className="h-[40px] bg-[#52B946] text-white text-[12px] font-black uppercase rounded-[10px] tracking-[1.1px] hover:bg-[#3E9434]">Invite</button>
                    </div>
                  </div>
                  
                  {tournament.participants.length < tournament.maxPlayers && (
                    <div className="pt-2 border-t border-[#2F2F2F]">
                      <button 
                        onClick={handleFillWithGuests}
                        className="w-full py-3 bg-transparent border-2 border-[#838383] text-[#838383] hover:border-[#52B946] hover:text-[#52B946] text-[10px] font-black uppercase rounded-[10px] tracking-[1.1px] transition-all"
                      >
                        Fill with Guests ({tournament.maxPlayers - tournament.participants.length} slots)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TournamentViewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-[#52B946] font-black uppercase tracking-[1.1px] bg-[#1B1B1B]">Synchronizing...</div>}>
      <TournamentViewContent />
    </Suspense>
  );
}
