"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authenticatedFetch, signOut } from "@/app/utils/api";

interface User {
  id: string;
  username: string;
  guestName?: string;
  email: string;
  roles: string[];
}

interface CurrentUser {
  sub: string;
  email: string;
  roles: string[];
  username: string;
  guestName?: string;
}

export default function HandleOrganizerPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 1. Check if current user is ADMIN
      const meRes = await authenticatedFetch(`${apiUrl}/auth/me`);
      if (meRes.ok) {
        const meData = await meRes.json();
        if (!meData.roles?.includes("ADMIN")) {
          router.push("/join_tournament");
          return;
        }
        setCurrentUser(meData);
      } else {
        router.push("/");
        return;
      }

      // 2. Fetch all registered users
      const usersRes = await authenticatedFetch(`${apiUrl}/auth/registered-users`);
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        setUsers(usersData);
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
      setMessage("Error: Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleOrganizer = async (user: User) => {
    setMessage("");
    const isCurrentlyOrganizer = user.roles.includes("ORGANIZER");
    let newRoles: string[];

    if (isCurrentlyOrganizer) {
      newRoles = user.roles.filter((r) => r !== "ORGANIZER");
    } else {
      newRoles = [...user.roles, "ORGANIZER"];
    }

    try {
      const response = await authenticatedFetch(`${apiUrl}/auth/roles/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: newRoles }),
      });

      if (response.ok) {
        setMessage(`Success: ${user.username} role updated`);
        // Refresh users list
        const updatedUsers = users.map((u) =>
          u.id === user.id ? { ...u, roles: newRoles } : u
        );
        setUsers(updatedUsers);
      } else {
        const data = await response.json();
        setMessage(`Error: ${data.message || "Failed to update role"}`);
      }
    } catch (error) {
      setMessage("Error: Failed to update role");
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(`${apiUrl}/auth/signout`);
    } catch {
      // ignore and redirect
    }
    router.push("/");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[#52B946] bg-[#1B1B1B]">
        <div className="text-xl font-black uppercase tracking-[1.1px]">Loading Admin Panel...</div>
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
              Organizer Management
            </h1>
            <div className="flex items-center gap-4 mt-1">
              <p className="text-[#838383] text-sm tracking-[1.1px] uppercase">
                {currentUser ? `Admin Control: ${currentUser.username}` : "Admin Access Required"}
              </p>
              <button
                onClick={() => router.push("/join_tournament")}
                className="text-xs text-[#52B946] hover:text-[#3E9434] font-bold uppercase tracking-[1.1px] underline transition-colors"
              >
                Back to Dashboard
              </button>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="text-xs text-red-500 hover:text-red-400 font-bold uppercase tracking-[1.1px] underline transition-colors"
          >
            Sign Out
          </button>
        </div>

        {/* Message area */}
        {message && (
          <div
            className={`w-full p-4 rounded-[10px] text-center font-bold tracking-[1.1px] uppercase ${
              message.startsWith("Error") ? "bg-red-500/10 text-red-500" : "bg-[#52B946]/10 text-[#6FFF5E]"
            }`}
          >
            {message}
          </div>
        )}

        {/* Users Table */}
        <div
          className="w-full rounded-[20px] overflow-hidden shadow-lg border-t-5 border-[#52B946]"
          style={{
            background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#171717]">
                  <th className="p-5 text-[#838383] uppercase font-black text-sm tracking-[1.1px]">Username</th>
                  <th className="p-5 text-[#838383] uppercase font-black text-sm tracking-[1.1px]">Email</th>
                  <th className="p-5 text-[#838383] uppercase font-black text-sm tracking-[1.1px]">Roles</th>
                  <th className="p-5 text-[#838383] uppercase font-black text-sm tracking-[1.1px]">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2F2F2F]">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-20 text-center text-[#838383] uppercase font-black tracking-[1.1px]">
                      No Registered Players Found
                    </td>
                  </tr>
                ) : (
                  users.map((user) => {
                    const isOrganizer = user.roles.includes("ORGANIZER");
                    const isAdmin = user.roles.includes("ADMIN");
                    
                    return (
                      <tr key={user.id} className="hover:bg-white/5 transition-colors">
                        <td className="p-5 text-white font-bold uppercase tracking-[1.1px]">
                          {user.guestName || user.username || "TBD"}
                        </td>
                        <td className="p-5 text-[#838383] font-medium tracking-[1.1px]">
                          {user.email}
                        </td>
                        <td className="p-5">
                          <div className="flex flex-wrap gap-2">
                            {user.roles.map((role) => (
                              <span
                                key={role}
                                className={`px-2 py-0.5 rounded-[5px] text-[10px] font-black uppercase tracking-[1.1px] ${
                                  role === "ADMIN" 
                                    ? "bg-purple-500 text-white" 
                                    : role === "ORGANIZER"
                                    ? "bg-[#52B946] text-white"
                                    : "bg-[#2F2F2F] text-[#838383]"
                                }`}
                              >
                                {role}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="p-5">
                          {!isAdmin && (
                            <button
                              onClick={() => handleToggleOrganizer(user)}
                              className={`px-4 py-2 rounded-[10px] text-[11px] font-black uppercase tracking-[1.1px] transition-all ${
                                isOrganizer
                                  ? "border-2 border-red-500 text-red-500 hover:bg-red-500 hover:text-white"
                                  : "bg-[#52B946] text-white hover:bg-[#3E9434]"
                              }`}
                            >
                              {isOrganizer ? "Deassign Organizer" : "Assign Organizer"}
                            </button>
                          )}
                          {isAdmin && (
                            <span className="text-[10px] text-[#838383] uppercase font-black tracking-[1.1px] italic">
                              Cannot Modify Admin
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}