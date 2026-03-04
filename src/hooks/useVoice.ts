import { useState, useRef, useCallback, useEffect } from "react";

export type VoiceState = "idle" | "listening" | "speaking";

interface UseVoiceOptions {
  onTranscript?: (text: string) => void;
  lang?: string;
}

export function useVoice({ onTranscript, lang = "ru-RU" }: UseVoiceOptions = {}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [supported, setSupported] = useState(false);
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const hasSynth = "speechSynthesis" in window;
    setSupported(!!SpeechRecognition && hasSynth);
    if (hasSynth) synthRef.current = window.speechSynthesis;
  }, []);

  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // Stop any ongoing TTS
    if (synthRef.current?.speaking) {
      synthRef.current.cancel();
    }

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => setState("listening");
    recognition.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      onTranscript?.(transcript);
    };
    recognition.onerror = () => setState("idle");
    recognition.onend = () => setState("idle");

    recognitionRef.current = recognition;
    recognition.start();
  }, [lang, onTranscript]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setState("idle");
  }, []);

  const speak = useCallback((text: string) => {
    if (!synthRef.current) return;
    synthRef.current.cancel();

    // Clean markdown from text
    const clean = text
      .replace(/```[\s\S]*?```/g, "код")
      .replace(/`[^`]+`/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/#{1,3}\s/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/---/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim();

    if (!clean) return;

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = lang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => setState("speaking");
    utterance.onend = () => setState("idle");
    utterance.onerror = () => setState("idle");

    synthRef.current.speak(utterance);
  }, [lang]);

  const stopSpeaking = useCallback(() => {
    synthRef.current?.cancel();
    setState("idle");
  }, []);

  const toggle = useCallback(() => {
    if (state === "listening") {
      stopListening();
    } else if (state === "speaking") {
      stopSpeaking();
    } else {
      startListening();
    }
  }, [state, startListening, stopListening, stopSpeaking]);

  return { state, supported, toggle, startListening, stopListening, speak, stopSpeaking };
}
