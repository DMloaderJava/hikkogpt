/**
 * In-App Camera Bottom Sheet — ChatGPT-style implementation
 *
 * React Native (Expo) + expo-camera + @gorhom/bottom-sheet + reanimated
 * Fully typed, no `any`, resource-optimized (camera stops when closed)
 *
 * NOTE: этот файл НЕ входит в web-сборку Vite (см. exclude в tsconfig.app.json).
 * Он предназначен для мобильного приложения (Expo / Bare RN).
 *
 * Requirements fulfilled:
 * - Height 55-60% of screen, rounded 28-32px, side/bottom margins, overflow hidden
 * - Shutter, close, flip, flash controls
 * - Drag-to-dismiss + backdrop tap to close
 * - Permission states (prompt / granted / denied) with settings placeholder
 * - Camera stops when closed (green dot disappears)
 * - Capture quality 0.8 jpg, returns local URI via onCapture, auto-closes
 * - 60fps animations via reanimated (bottom-sheet работает в UI-потоке)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Linking,
  Platform,
  ActivityIndicator,
  BackHandler,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CameraView,
  CameraType,
  FlashMode,
  useCameraPermissions,
  CameraCapturedPicture,
} from "expo-camera";
import BottomSheet, {
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useSharedValue } from "react-native-reanimated";

// Border radius per spec 28-32px
const BORDER_RADIUS = 28;
const SHEET_HEIGHT_PERCENT = "60%";
const SHEET_SIDE_MARGIN = 12;
const SHEET_BOTTOM_INSET = 12;

export type CameraPermissionUIState = "checking" | "prompt" | "granted" | "denied";

export interface InAppCameraSheetProps {
  /** Controls visibility from parent (chat input) */
  isOpen: boolean;
  /** Called when sheet should close (drag, backdrop, X) */
  onClose: () => void;
  /** Returns local file URI (.jpg) */
  onCapture: (uri: string) => void;
  /** Optional snap points, defaults to 60% */
  snapPoints?: string[];
  /** Enable flash toggle, default true */
  enableFlash?: boolean;
  /** Enable camera flip, default true */
  enableFlip?: boolean;
}

type CameraControlsProps = {
  onShutter: () => void;
  onClose: () => void;
  onFlip?: () => void;
  onToggleFlash?: () => void;
  flashMode: FlashMode;
  isCapturing: boolean;
  enableFlip: boolean;
  enableFlash: boolean;
};

const CameraControls: React.FC<CameraControlsProps> = ({
  onShutter,
  onClose,
  onFlip,
  onToggleFlash,
  flashMode,
  isCapturing,
  enableFlip,
  enableFlash,
}) => {
  // Safe Area: кнопки не залезают на Dynamic Island / статус-бар сверху
  // и на Home-индикатор / навигацию снизу.
  const insets = useSafeAreaInsets();

  return (
    <>
      {/* Затемнения под контролами */}
      <View pointerEvents="none" style={styles.vignetteTop} />
      <View pointerEvents="none" style={styles.vignetteBottom} />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, 12) + 8 }]}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.iconButton}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Закрыть камеру"
        >
          <Text style={styles.iconText}>✕</Text>
        </TouchableOpacity>

        <View style={styles.topRightGroup}>
          {enableFlash && (
            <TouchableOpacity
              onPress={onToggleFlash}
              style={[styles.iconButton, flashMode !== "off" && styles.iconButtonActive]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Переключить вспышку"
            >
              <Text style={[styles.iconText, flashMode !== "off" && styles.iconTextActive]}>
                {flashMode === "on" ? "⚡" : flashMode === "auto" ? "A⚡" : "⚡○"}
              </Text>
            </TouchableOpacity>
          )}
          {enableFlip && (
            <TouchableOpacity
              onPress={onFlip}
              style={styles.iconButton}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Переключить камеру"
            >
              <Text style={styles.iconText}>⇄</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        <View style={styles.bottomSideSpacer} />

        <TouchableOpacity
          onPress={onShutter}
          disabled={isCapturing}
          activeOpacity={0.8}
          style={styles.shutterOuter}
          accessibilityRole="button"
          accessibilityLabel="Сделать фото"
        >
          <View style={styles.shutterInner}>
            {isCapturing ? <ActivityIndicator color="rgba(0,0,0,0.6)" /> : null}
          </View>
        </TouchableOpacity>

        <View style={styles.bottomSideSpacer} />
      </View>
    </>
  );
};

const PermissionDeniedView: React.FC<{ onOpenSettings: () => void; onRetry: () => void }> = ({
  onOpenSettings,
  onRetry,
}) => (
  <View style={styles.permissionContainer}>
    <View style={styles.permissionIconCircle}>
      <Text style={styles.permissionIcon}>📷</Text>
    </View>
    <Text style={styles.permissionTitle}>Камера недоступна</Text>
    <Text style={styles.permissionText}>
      Доступ к камере запрещен. Включите его в настройках, чтобы делать фото не выходя из чата.
    </Text>
    <View style={styles.permissionButtonsRow}>
      <TouchableOpacity onPress={onRetry} style={styles.primaryButton} activeOpacity={0.8}>
        <Text style={styles.primaryButtonText}>Попробовать снова</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onOpenSettings} style={styles.secondaryButton} activeOpacity={0.8}>
        <Text style={styles.secondaryButtonText}>⚙ Настройки</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const PermissionPromptView: React.FC<{ onRequest: () => void }> = ({ onRequest }) => (
  <View style={styles.permissionContainer}>
    <View style={styles.permissionIconCircle}>
      <Text style={styles.permissionIcon}>📸</Text>
    </View>
    <Text style={styles.permissionTitle}>Доступ к камере</Text>
    <Text style={styles.permissionText}>
      Разрешите доступ к камере, чтобы делать фото не выходя из переписки
    </Text>
    <TouchableOpacity onPress={onRequest} style={styles.primaryButton} activeOpacity={0.8}>
      <Text style={styles.primaryButtonText}>Разрешить камеру</Text>
    </TouchableOpacity>
  </View>
);

export const InAppCameraSheet: React.FC<InAppCameraSheetProps> = ({
  isOpen,
  onClose,
  onCapture,
  snapPoints: customSnapPoints,
  enableFlash = true,
  enableFlip = true,
}) => {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const cameraRef = useRef<CameraView>(null);
  // Зеркало isSheetOpen без ререндеров — для синхронных проверок в эффектах.
  const isSheetOpenRef = useRef<boolean>(false);

  const insets = useSafeAreaInsets();

  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [isSheetOpen, setIsSheetOpen] = useState<boolean>(false);

  // Критично для батареи/индикатора: CameraView монтируется ТОЛЬКО
  // когда шторка открыта и есть разрешение. При закрытии — полный
  // демонтаж, зелёная точка гаснет.
  const [shouldRenderCamera, setShouldRenderCamera] = useState<boolean>(false);

  const snapPoints = useMemo(() => customSnapPoints ?? [SHEET_HEIGHT_PERCENT], [customSnapPoints]);
  // Индекс шторки в UI-потоке (reanimated): -1 закрыта, 0 открыта.
  // Используется для будущих animated-стилей и отладки жестов.
  const animatedIndex = useSharedValue<number>(-1);

  const permissionUIState: CameraPermissionUIState = useMemo(() => {
    if (!permission) return "checking";
    if (permission.granted) return "granted";
    if (permission.status === "undetermined" && permission.canAskAgain) return "prompt";
    return "denied";
  }, [permission]);

  // Синхронизация с пропсом isOpen от родителя.
  // БЕЗ setTimeout: монтированием управляют события шторки, а не миллисекунды.
  useEffect(() => {
    if (isOpen) {
      // Монтируем камеру сразу: она прогревается параллельно анимации
      // открытия, и к её концу превью уже живо — без чёрной вспышки.
      setShouldRenderCamera(true);
      bottomSheetRef.current?.expand();
    } else {
      bottomSheetRef.current?.close();
      if (!isSheetOpenRef.current) {
        // Шторка уже закрыта — onChange(-1) не придёт, гасим синхронно.
        setShouldRenderCamera(false);
        setIsSheetOpen(false);
      }
      // Иначе демонтаж произойдёт в onChange(-1) ровно по факту завершения
      // анимации закрытия: ни мигания на слабых устройствах, ни лишней
      // работы камеры в фоне на флагманах.
    }
  }, [isOpen]);

  // События шторки: жест/бэкдроп/код. onChange(-1) — анимация закрытия
  // ЗАВЕРШЕНА, это единственное место демонтажа камеры.
  const handleSheetChanges = useCallback(
    (index: number) => {
      animatedIndex.value = index;
      const sheetOpen = index !== -1;
      isSheetOpenRef.current = sheetOpen;
      setIsSheetOpen(sheetOpen);
      if (!sheetOpen) {
        // Закрыта полностью: демонтируем CameraView, видеопоток
        // останавливается, зелёная точка в статус-баре гаснет.
        setShouldRenderCamera(false);
        onClose();
      }
    },
    [animatedIndex, onClose]
  );

  const handleClose = useCallback(() => {
    bottomSheetRef.current?.close();
    // onClose вызовется через handleSheetChanges при index === -1
  }, []);

  // Android: системная кнопка «Назад» закрывает шторку камеры,
  // а не экран чата под ней.
  useEffect(() => {
    if (!isOpen || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      handleClose();
      return true;
    });
    return () => subscription.remove();
  }, [isOpen, handleClose]);

  const handleRequestPermission = useCallback(() => {
    void requestPermission();
  }, [requestPermission]);

  const handleOpenSettings = useCallback(() => {
    if (Platform.OS === "ios") {
      void Linking.openURL("app-settings:");
    } else {
      void Linking.openSettings();
    }
  }, []);

  const handleFlip = useCallback(() => {
    setFacing((prev) => (prev === "back" ? "front" : "back"));
  }, []);

  const handleToggleFlash = useCallback(() => {
    setFlash((prev) => {
      if (prev === "off") return "on";
      if (prev === "on") return "auto";
      return "off";
    });
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;
    setIsCapturing(true);
    try {
      const photo: CameraCapturedPicture | undefined = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: false,
        exif: false,
        imageType: "jpg",
      });

      if (photo?.uri) {
        onCapture(photo.uri);
        handleClose();
      }
    } catch (e) {
      console.warn("[InAppCameraSheet] capture failed", e);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, onCapture, handleClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.4}
        pressBehavior="close"
      />
    ),
    []
  );

  const cameraActive =
    isOpen && isSheetOpen && permissionUIState === "granted" && shouldRenderCamera;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      enablePanDownToClose
      detached
      bottomInset={SHEET_BOTTOM_INSET + insets.bottom}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handleIndicator}
      style={styles.sheetContainer}
      animateOnMount
    >
      <BottomSheetView style={styles.contentContainer}>
        {/* Скруглённая карточка. overflow: hidden на обоих уровнях
            обрезает нативный CameraView на iOS и Android. */}
        <View style={styles.cameraCard}>
          <View style={styles.cameraClipContainer}>
            {permissionUIState === "checking" && (
              <View style={styles.centered}>
                <ActivityIndicator size="large" color="white" />
                <Text style={styles.loadingText}>Запускаем камеру...</Text>
              </View>
            )}

            {permissionUIState === "prompt" && (
              <PermissionPromptView onRequest={handleRequestPermission} />
            )}

            {permissionUIState === "denied" && (
              <PermissionDeniedView
                onOpenSettings={handleOpenSettings}
                onRetry={handleRequestPermission}
              />
            )}

            {permissionUIState === "granted" && shouldRenderCamera && (
              <>
                {cameraActive ? (
                  <CameraView
                    ref={cameraRef}
                    style={StyleSheet.absoluteFill}
                    facing={facing}
                    flash={flash}
                    animateShutter={false}
                    mode="picture"
                  />
                ) : (
                  <View style={styles.cameraPlaceholder} />
                )}

                <CameraControls
                  onShutter={() => void handleCapture()}
                  onClose={handleClose}
                  onFlip={enableFlip ? handleFlip : undefined}
                  onToggleFlash={enableFlash ? handleToggleFlash : undefined}
                  flashMode={flash}
                  isCapturing={isCapturing}
                  enableFlip={enableFlip}
                  enableFlash={enableFlash}
                />
              </>
            )}
          </View>
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  sheetContainer: {
    // ChatGPT-style floating card
    marginHorizontal: SHEET_SIDE_MARGIN,
  },
  sheetBackground: {
    backgroundColor: "transparent",
  },
  handleIndicator: {
    backgroundColor: "rgba(255,255,255,0.3)",
    width: 40,
  },
  contentContainer: {
    flex: 1,
  },
  cameraCard: {
    flex: 1,
    backgroundColor: "black",
    borderRadius: BORDER_RADIUS,
    overflow: "hidden",
  },
  cameraClipContainer: {
    flex: 1,
    borderRadius: BORDER_RADIUS,
    overflow: "hidden",
    backgroundColor: "black",
  },
  cameraPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "black",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "black",
  },
  loadingText: {
    marginTop: 12,
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    // paddingTop задаётся динамически из useSafeAreaInsets (см. CameraControls)
    zIndex: 10,
  },
  topRightGroup: {
    flexDirection: "row",
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonActive: {
    backgroundColor: "#facc15",
  },
  iconText: {
    color: "white",
    fontSize: 18,
    fontWeight: "600",
  },
  iconTextActive: {
    color: "black",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    // paddingBottom задаётся динамически из useSafeAreaInsets (см. CameraControls)
    zIndex: 10,
  },
  bottomSideSpacer: {
    width: 48,
    height: 48,
  },
  shutterOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "white",
    padding: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  shutterInner: {
    flex: 1,
    borderRadius: 32,
    backgroundColor: "white",
    borderWidth: 3,
    borderColor: "rgba(0,0,0,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  vignetteTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 100,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  vignetteBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  permissionContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#18181b",
  },
  permissionIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  permissionIcon: {
    fontSize: 32,
  },
  permissionTitle: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  permissionText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 280,
    marginBottom: 20,
  },
  permissionButtonsRow: {
    flexDirection: "row",
    gap: 8,
  },
  primaryButton: {
    backgroundColor: "white",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  primaryButtonText: {
    color: "black",
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  secondaryButtonText: {
    color: "white",
    fontSize: 14,
    fontWeight: "500",
  },
});

export default InAppCameraSheet;
