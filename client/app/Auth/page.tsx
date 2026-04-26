"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    const endpoint = mode === "login" ? "signin" : "signup";
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

    try {
      const response = await fetch(`${apiUrl}/auth/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ identifier, password }),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage(`Success: ${mode === "login" ? "Signed in" : "Signed up"}`);

        setTimeout(() => {
          router.push("/join_tournament");
        }, 1000);
      } else {
        setMessage(`Error: ${data.message || "Something went wrong"}`);
      }
    } catch (error) {
      setMessage("Error: Failed to connect to server");
      console.error(error);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(180deg, rgba(102,102,102,0.00) 38.15%, rgba(82,185,70,0.20) 100%), #1B1B1B",
      }}
    >
      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div
          className="w-full max-w-119.25 rounded-[20px] p-8 sm:p-12.5 flex flex-col items-center gap-3.5"
          style={{
            background: "linear-gradient(180deg, #2A2A2A 0%, #212121 100%)",
            boxShadow: "0 4px 20px 0 rgba(0,0,0,0.25)",
            borderTop: "5px solid #3E9434",
          }}
        >
          {/* Logo */}
          <Image
            src="https://api.builder.io/api/v1/image/assets/TEMP/5f45c8f43d6319e9db9028acb938e6934fbab53a?width=600"
            alt="Hobby+ Logo"
            width={300}
            height={85}
            className="w-60 sm:w-75 h-auto object-contain"
            priority
          />

          {/* Login / Sign Up Tabs */}
          <div
            className="w-full flex items-center gap-7 rounded-[20px] p-2.5"
            style={{ background: "#171717" }}
          >
            <button
              onClick={() => setMode("login")}
              className={`flex-1 h-12.5 sm:h-15 rounded-[10px] flex items-center justify-center transition-colors font-semibold text-lg sm:text-2xl tracking-[1.1px] uppercase text-white ${
                mode === "login"
                  ? "bg-[#52B946]"
                  : "bg-transparent hover:bg-white/5"
              }`}
            >
              Sign in
            </button>
            <button
              onClick={() => setMode("signup")}
              className={`flex-1 h-12.5 sm:h-15 rounded-[10px] flex items-center justify-center transition-colors font-semibold text-lg sm:text-2xl tracking-[1.1px] uppercase text-white ${
                mode === "signup"
                  ? "bg-[#52B946]"
                  : "bg-transparent hover:bg-white/5"
              }`}
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
            {/* Email / Username Field */}
            <div className="flex flex-col gap-2">
              <label className="text-white text-[15px] tracking-[1.1px] uppercase leading-[16.5px]">
                Email/Username
              </label>
              <div
                className="w-full h-12.5 rounded-[5px] flex items-center px-3.75"
                style={{ background: "#101010" }}
              >
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="Enter your credentials"
                  className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] uppercase outline-none placeholder:text-[#838383]"
                  required
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <label className="text-white text-[15px] tracking-[1.1px] uppercase leading-[16.5px]">
                  Password
                </label>
                <button
                  type="button"
                  className="text-[#6FFF5E] text-[12px] tracking-[1.1px] uppercase leading-[16.5px] border-b border-[#52B946] hover:text-white transition-colors"
                >
                  Forgot Password?
                </button>
              </div>
              <div
                className="w-full h-12.5 rounded-[5px] flex items-center px-3.75"
                style={{ background: "#101010" }}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-transparent text-[12px] text-[#838383] tracking-[1.1px] outline-none placeholder:text-[#838383]"
                  required
                />
              </div>
            </div>

            {/* Message display */}
            {message && (
              <div
                className={`text-sm text-center ${
                  message.startsWith("Error")
                    ? "text-red-500"
                    : "text-[#6FFF5E]"
                }`}
              >
                {message}
              </div>
            )}

            {/* Submit Button */}
            <div className="flex justify-center mt-2">
              <button
                type="submit"
                className="w-60 sm:w-70 h-15 rounded-[20px] bg-[#52B946] hover:bg-[#3E9434] transition-colors flex items-center justify-center font-black text-[18px] sm:text-[20px] tracking-[1.1px] uppercase text-white"
              >
                {mode === "login" ? "Enter Arena" : "Join Arena"}
              </button>
            </div>
          </form>
        </div>
      </main>

      {/* Footer */}
      <footer
        className="w-full border-t-4 border-[#2F2F2F]"
        style={{ background: "#1B1B1B" }}
      >
        <div className="max-w-480 mx-auto px-6 sm:px-25 py-2.5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 sm:gap-0 min-h-20 sm:min-h-25">
          {/* Contact Info */}
          <div className="flex flex-col gap-2.5">
            <span className="text-[#838383] text-base sm:text-[20px]">Contact no:</span>
            <span className="text-[#838383] text-base sm:text-[20px]">Email:</span>
            <span className="text-[#838383] text-base sm:text-[20px]">Facebook</span>
          </div>

          {/* Shop Links */}
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-[#838383] text-base sm:text-[20px] text-center">Lazada</span>
            <span className="text-[#838383] text-base sm:text-[20px] text-center">Shoppee</span>
          </div>

          {/* Location */}
          <div className="flex items-center justify-center p-2.5">
            <span className="text-[#838383] text-base sm:text-[20px] text-center">Location</span>
          </div>
        </div>
      </footer>
    </div>
  );
}