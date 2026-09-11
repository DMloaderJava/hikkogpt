import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import {
  X,
  CameraOff,
  SwitchCamera,
  Zap,
  ZapOff,
  Loader2,
  Image as ImageIcon,
  Camera as CameraIcon,
} from "lucide-react";
import { useCameraStream } from "@/hooks/useCameraStream";
import type { CapturedPhoto } from "@/lib/imageAttachments";

export interface CameraBottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Снимок: Blob + лёгкий object URL (JPEG q0.8).
   * Владение URL переходит родителю — он обязан вызвать URL.revokeObjectURL,
   * когда превью больше не нужно (удаление / отправка / размонтирование).
   */
  onCapture: (photo: CapturedPhoto) => void;
  /** Вызывается после закрытия шторки */
  onClose?: () => void;
}

const BORDER_RADIUS = 28;
const SHEET_HEIGHT = "60dvh";

export function CameraBottomSheet({ open, onOpenChange, onCapture, onClose }: CameraBottomSheetProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const prevOpenRef = useRef(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const {
    videoRef,
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
  } = useCameraStream({
    enabled: open,
    facing: "environment",
  });

  // Вызываем onClose только на переходе open: true -> false.
  // Через ref, чтобы нестабильный колбэк родителя не перезапускал эффект.
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (wasOpen && !open) {
      stopStream();
      setIsCapturing(false);
      onCloseRef.current?.();
    }
  }, [open, stopStream]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleCapture = useCallback(async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    try {
      const photo = await capturePhoto(0.8);
      if (photo) {
        onCapture(photo);
        // Автозакрытие после снимка по ТЗ
        onOpenChange(false);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [capturePhoto, isCapturing, onCapture, onOpenChange]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      // Гасим поток немедленно, не дожидаясь перерендера —
      // индикатор камеры должен погаснуть сразу.
      stopStream();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, stopStream]);

  const handleRetryPermission = useCallback(() => {
    void requestPermission();
  }, [requestPermission]);

  const clipStyle: React.CSSProperties = {
    borderRadius: BORDER_RADIUS,
    overflow: "hidden",
    transform: "translateZ(0)",
    // Двойная страховка скругления видео на iOS Safari
    clipPath: `inset(0 round ${BORDER_RADIUS}px)`,
    WebkitClipPath: `inset(0 round ${BORDER_RADIUS}px)`,
  };

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      shouldScaleBackground={false}
      modal={true}
      dismissible={true}
      repositionInputs={false}
    >
      <Drawer.Portal>
        {/* Затемнение — клик закрывает, чат сзади частично виден */}
        <Drawer.Overlay
          className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]"
          data-testid="camera-sheet-overlay"
        />

        {/* Шторка 60% высоты. Drag-to-dismiss из коробки (vaul). */}
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-[101] flex flex-col outline-none"
          style={{ height: SHEET_HEIGHT, maxHeight: SHEET_HEIGHT }}
          aria-label="Камера"
          data-testid="camera-sheet"
        >
          {/* A11y для vaul/radix */}
          <Drawer.Title className="sr-only">Камера</Drawer.Title>
          <Drawer.Description className="sr-only">
            Сделайте фото, не выходя из чата
          </Drawer.Description>

          {/* Карточка в стиле ChatGPT: отступы + скругление + тень */}
          <div
            className="relative mx-2 mb-2 flex flex-1 flex-col overflow-hidden bg-black shadow-2xl sm:mx-3 sm:mb-3"
            style={clipStyle}
          >
            {/* Ручка для драга */}
            <div
              className="absolute left-1/2 top-3 z-20 h-1.5 w-10 -translate-x-1/2 rounded-full bg-white/30"
              aria-hidden="true"
            />

            {/* Контейнер видоискателя — видео обрезается по скруглению */}
            <div className="relative flex-1 overflow-hidden bg-black" style={clipStyle}>
              {/* Видеопоток. Монтируется только при granted; при закрытии
                  шторки enabled=false -> треки останавливаются в хуке. */}
              {permission === "granted" && (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  disablePictureInPicture
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{
                    borderRadius: BORDER_RADIUS,
                    transform: facing === "user" ? "scaleX(-1)" : "none",
                    WebkitTransform: facing === "user" ? "scaleX(-1) translateZ(0)" : "translateZ(0)",
                  }}
                  data-testid="camera-video"
                />
              )}

              {/* Загрузка */}
              {open && permission === "checking" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black text-white">
                  <Loader2 className="h-8 w-8 animate-spin text-white/80" />
                  <p className="mt-3 text-sm text-white/60">Запускаем камеру...</p>
                </div>
              )}

              {/* Первичный запрос разрешения (если хук ещё не стартовал поток) */}
              {permission === "prompt" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-900 p-6 text-center text-white">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
                    <CameraIcon className="h-8 w-8 text-white/80" />
                  </div>
                  <h3 className="mb-2 text-base font-semibold">Доступ к камере</h3>
                  <p className="mb-5 max-w-[260px] text-sm text-white/60">
                    Разрешите доступ к камере, чтобы делать фото не выходя из чата
                  </p>
                  <button
                    onClick={handleRetryPermission}
                    className="rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition-all active:scale-95"
                  >
                    Разрешить камеру
                  </button>
                </div>
              )}

              {/* Отказ в доступе — аккуратная заглушка */}
              {permission === "denied" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-900 p-6 text-center text-white">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
                    <CameraOff className="h-8 w-8 text-white/70" />
                  </div>
                  <h3 className="mb-2 text-[15px] font-semibold">Камера недоступна</h3>
                  <p className="mb-1 max-w-[280px] text-sm text-white/60">
                    {error || "Доступ к камере запрещен. Включите его в настройках браузера."}
                  </p>
                  <p className="mb-5 max-w-[280px] text-xs text-white/40">
                    На iOS: Настройки → Safari → Камера. На Android: настройки сайта → Разрешения.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleRetryPermission}
                      className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black transition-all active:scale-95"
                    >
                      Попробовать снова
                    </button>
                    <button
                      onClick={handleClose}
                      className="rounded-full bg-white/10 px-5 py-2.5 text-sm font-medium text-white transition-all active:scale-95"
                    >
                      Закрыть
                    </button>
                  </div>
                </div>
              )}

              {permission === "unsupported" && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-900 p-6 text-center text-white">
                  <CameraOff className="mb-3 h-10 w-10 text-white/50" />
                  <p className="text-sm text-white/60">Камера не поддерживается в этом браузере</p>
                  <button
                    onClick={handleClose}
                    className="mt-4 rounded-full bg-white/10 px-5 py-2 text-sm text-white"
                  >
                    Закрыть
                  </button>
                </div>
              )}

              {/* Контролы поверх видоискателя */}
              {permission === "granted" && (
                <>
                  {/* Затемнения для читаемости кнопок (под контролами) */}
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/50 to-transparent"
                    aria-hidden="true"
                  />
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/60 to-transparent"
                    aria-hidden="true"
                  />

                  {/* Верхняя панель */}
                  <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between p-3 pt-8">
                    <button
                      onClick={handleClose}
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md transition-all active:scale-90"
                      aria-label="Закрыть камеру"
                    >
                      <X className="h-5 w-5" />
                    </button>

                    <div className="flex items-center gap-2">
                      {isTorchSupported && (
                        <button
                          onClick={() => void toggleTorch()}
                          className={`flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md transition-all active:scale-90 ${
                            torchEnabled ? "bg-yellow-400 text-black" : "bg-black/40 text-white"
                          }`}
                          aria-label={torchEnabled ? "Выключить вспышку" : "Включить вспышку"}
                          aria-pressed={torchEnabled}
                        >
                          {torchEnabled ? <Zap className="h-5 w-5 fill-current" /> : <ZapOff className="h-5 w-5" />}
                        </button>
                      )}

                      <button
                        onClick={toggleFacing}
                        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md transition-all active:scale-90"
                        aria-label="Переключить камеру"
                      >
                        <SwitchCamera className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {/* Нижняя панель — затвор по центру */}
                  <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between p-4 pb-6">
                    <div className="h-12 w-12" aria-hidden="true" />

                    <button
                      onClick={() => void handleCapture()}
                      disabled={isCapturing}
                      className="group relative flex h-[72px] w-[72px] items-center justify-center rounded-full bg-white p-1 shadow-lg shadow-black/20 transition-all active:scale-95 disabled:opacity-60"
                      aria-label="Сделать фото"
                      data-testid="camera-shutter"
                    >
                      <span className="h-full w-full rounded-full border-[3px] border-black/10 bg-white transition-all group-active:scale-90" />
                      {isCapturing && (
                        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white">
                          <Loader2 className="h-6 w-6 animate-spin text-black/60" />
                        </span>
                      )}
                    </button>

                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/40 backdrop-blur-md"
                      aria-hidden="true"
                    >
                      <ImageIcon className="h-5 w-5 text-white/60" />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
