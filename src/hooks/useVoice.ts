import { useState, useRef, useCallback, useEffect } from "react";
import { getEdgeAuthHeaders } from "@/lib/edgeAuth";

export type VoiceState = "idle" | "listening" | "processing" | "speaking";

interface UseVoiceOptions {
  onTranscript?: (text: string) => void;
  lang?: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function useVoice({ onTranscript, lang = "ru-RU" }: UseVoiceOptions = {}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [supported, setSupported] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const hasMedia = !!(navigator.mediaDevices?.getUserMedia);
    const hasSynth = "speechSynthesis" in window;
    setSupported(hasMedia);
    if (hasSynth) synthRef.current = window.speechSynthesis;
  }, []);

  const startListening = useCallback(async () => {
    try {
      // Stop any ongoing TTS
      if (synthRef.current?.speaking) {
        synthRef.current.cancel();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        setState("processing");
        // Stop stream tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];

        try {
          const formData = new FormData();
          formData.append("audio", audioBlob, "audio.webm");
          // Map browser language code to ISO 639-3 for ElevenLabs
          const langMap: Record<string, string> = {
            "ru-RU": "rus",
            "en-US": "eng",
            "en-GB": "eng",
            "uk-UA": "ukr",
          };
          formData.append("language", langMap[lang] || "rus");

          const response = await fetch(
            `${SUPABASE_URL}/functions/v1/elevenlabs-stt`,
            {
              method: "POST",
              headers: await getEdgeAuthHeaders(),
              body: formData,
            }
          );

          if (!response.ok) throw new Error(`STT request failed: ${response.status}`);

          const data = await response.json();
          if (data.text) {
            onTranscript?.(data.text);
          }
        } catch (err) {
          console.error("STT transcription error:", err);
        } finally {
          setState("idle");
        }
      };

      recorder.start();
      setState("listening");
    } catch (err) {
      console.error("Microphone access error:", err);
      setState("idle");
    }
  }, [lang, onTranscript]);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    } else {
      // Clean up stream if recorder not started properly
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState("idle");
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (!synthRef.current) return;
    synthRef.current.cancel();

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
    } else if (state === "idle") {
      startListening();
    }
    // "processing" state — do nothing, wait
  }, [state, startListening, stopListening, stopSpeaking]);

  return { state, supported, toggle, startListening, stopListening, speak, stopSpeaking };
}
