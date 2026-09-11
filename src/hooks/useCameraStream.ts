import { useCallback, useEffect, useRef, useState } from "react";
import type { CapturedPhoto } from "@/lib/imageAttachments";

export type { CapturedPhoto };

export type CameraPermissionState = "prompt" | "granted" | "denied" | "checking" | "unsupported";
export type CameraFacing = "user" | "environment";

interface UseCameraStreamOptions {
  enabled: boolean;
  facing: CameraFacing;
  onError?: (message: string) => void;
}

interface UseCameraStreamReturn {
  stream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  permission: CameraPermissionState;
  error: string | null;
  facing: CameraFacing;
  isTorchSupported: boolean;
  torchEnabled: boolean;
  requestPermission: () => Promise<void>;
  stopStream: () => void;
  toggleFacing: () => void;
  toggleTorch: () => Promise<void>;
  capturePhoto: (quality?: number) => Promise<CapturedPhoto | null>;
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}

function getErrorMessage(err: unknown): { state: CameraPermissionState; message: string } {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return { state: "denied", message: "Доступ к камере запрещен" };
      case "NotFoundError":
      case "DevicesNotFoundError":
      case "OverconstrainedError":
        return { state: "denied", message: "Камера не найдена" };
      case "NotReadableError":
      case "TrackStartError":
        return { state: "denied", message: "Камера уже используется другим приложением" };
      case "SecurityError":
        return { state: "denied", message: "Камера доступна только в безопасном контексте (HTTPS)" };
      default:
        return { state: "denied", message: err.message || "Не удалось получить доступ к камере" };
    }
  }
  if (err instanceof Error) {
    return { state: "denied", message: err.message || "Не удалось получить доступ к камере" };
  }
  return { state: "denied", message: "Не удалось получить доступ к камере" };
}

export function useCameraStream({ enabled, facing: initialFacing, onError }: UseCameraStreamOptions): UseCameraStreamReturn {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [permission, setPermission] = useState<CameraPermissionState>("checking");
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<CameraFacing>(initialFacing);
  const [isTorchSupported, setIsTorchSupported] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Монотонный id запроса — защита от race condition при быстром
  // переключении камеры / открытии-закрытии шторки.
  const requestIdRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const stopStream = useCallback(() => {
    // Инвалидируем все pending-запросы getUserMedia
    requestIdRef.current += 1;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
    setStream((prev) => (prev ? null : prev));
    setTorchEnabled(false);
    setIsTorchSupported(false);
    if (videoRef.current) {
      try {
        videoRef.current.pause();
      } catch {
        // ignore
      }
      videoRef.current.srcObject = null;
    }
  }, []);

  const checkTorchSupport = useCallback((mediaStream: MediaStream) => {
    try {
      const track = mediaStream.getVideoTracks()[0];
      if (!track || typeof track.getCapabilities !== "function") {
        setIsTorchSupported(false);
        return;
      }
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      setIsTorchSupported(Boolean(capabilities && capabilities.torch));
    } catch {
      setIsTorchSupported(false);
    }
  }, []);

  const attachToVideo = useCallback((mediaStream: MediaStream) => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.srcObject !== mediaStream) {
        video.srcObject = mediaStream;
      }
    } catch {
      return;
    }
    try {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // Autoplay может быть заблокирован до жеста — игнорируем,
          // поток уже идёт, play повторится при attach-эффекте.
        });
      }
    } catch {
      // jsdom / заблокированный autoplay — игнорируем
    }
  }, []);

  const startStream = useCallback(async (targetFacing: CameraFacing) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPermission("unsupported");
      setError("Камера не поддерживается в этом браузере");
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setError(null);
    setPermission("checking");

    // Останавливаем предыдущий поток перед стартом нового
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: targetFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      // Запрос устарел (шторка закрыта / сменилась камера) — сразу гасим треки
      if (requestId !== requestIdRef.current || !enabledRef.current) {
        mediaStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
        return;
      }

      streamRef.current = mediaStream;
      setStream(mediaStream);
      setPermission("granted");
      checkTorchSupport(mediaStream);
      attachToVideo(mediaStream);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const { state, message } = getErrorMessage(err);
      setPermission(state);
      setError(message);
      if (err instanceof Error) {
        onError?.(err.message);
      } else {
        onError?.(message);
      }
    }
  }, [attachToVideo, checkTorchSupport, onError]);

  const requestPermission = useCallback(async () => {
    await startStream(facing);
  }, [facing, startStream]);

  const toggleFacing = useCallback(() => {
    setFacing((prev) => (prev === "user" ? "environment" : "user"));
  }, []);

  const toggleTorch = useCallback(async () => {
    if (!streamRef.current || !isTorchSupported) return;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      if (!track) return;
      const newState = !torchEnabled;
      await track.applyConstraints({
        advanced: [{ torch: newState } as TorchConstraintSet],
      });
      setTorchEnabled(newState);
    } catch {
      // Torch toggle failed, ignore
    }
  }, [isTorchSupported, torchEnabled]);

  const capturePhoto = useCallback(async (quality = 0.8): Promise<CapturedPhoto | null> => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return null;
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Для фронталки отражаем кадр — так результат совпадает с превью
    if (facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (facing === "user") {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const clampedQuality = Math.min(1, Math.max(0.1, quality));

    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), "image/jpeg", clampedQuality);
      } catch {
        resolve(null);
      }
    });
    if (!blob) return null;

    // Возвращаем Blob + лёгкий object URL. В dataURL (base64) конвертируем
    // только в момент отправки, чтобы не держать мегабайты текста в стейте.
    // Владение URL переходит вызывающей стороне (она же делает revoke).
    try {
      return { blob, url: URL.createObjectURL(blob) };
    } catch {
      return null;
    }
  }, [facing]);

  // Синхронизируем внутреннее состояние facing с пропсом
  useEffect(() => {
    setFacing(initialFacing);
  }, [initialFacing, enabled]);

  // Старт/стоп потока по enabled. Критично для батареи и индикатора камеры:
  // при enabled=false все треки останавливаются (зелёная точка гаснет).
  useEffect(() => {
    if (enabled) {
      setPermission("checking");
      void startStream(facing);
    } else {
      stopStream();
      // Сбрасываем в checking, чтобы при следующем открытии
      // сразу показывался лоадер, а не stale denied/granted
      setPermission("checking");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Перезапуск при смене камеры, только если поток уже был
  useEffect(() => {
    if (enabled && stream) {
      void startStream(facing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing]);

  // Прицепляем поток к <video>, когда оба доступны.
  // Важно: video может маунтиться позже, чем приходит stream.
  useEffect(() => {
    if (videoRef.current && stream) {
      attachToVideo(stream);
    }
  }, [stream, attachToVideo, permission]);

  // Финальная зачистка при размонтировании
  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            // ignore
          }
        });
        streamRef.current = null;
      }
    };
  }, []);

  return {
    stream,
    videoRef: videoRef as React.RefObject<HTMLVideoElement>,
    permission,
    error,
    facing,
    isTorchSupported,
    torchEnabled,
    requestPermission,
    stopStream,
    toggleFacing,
    toggleTorch,
    capturePhoto,
  };
}
