/**
 * Re-export for mobile/ folder convenience.
 * Real implementation lives in src/components/native/InAppCameraSheet.tsx
 * (React Native + expo-camera + @gorhom/bottom-sheet, excluded from web build).
 */
/* eslint-disable react-refresh/only-export-components -- native re-export shim, no fast refresh */
export { InAppCameraSheet, default } from "../../src/components/native/InAppCameraSheet";
export type {
  InAppCameraSheetProps,
  CameraPermissionUIState,
} from "../../src/components/native/InAppCameraSheet";
