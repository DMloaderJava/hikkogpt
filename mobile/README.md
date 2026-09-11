# In-App Camera Bottom Sheet — ChatGPT Style

Реализация встроенного видоискателя камеры в виде шторки 55-60% высоты экрана, как в ChatGPT.

## Стек

- **React Native** (Expo SDK 51+ или Bare)
- **expo-camera** `~15.0+` — CameraView API
- **@gorhom/bottom-sheet** `^5.0+` — шторка
- **react-native-reanimated** `^3.10+` — 60fps анимации
- **react-native-gesture-handler** — жесты

## Установка

```bash
# Expo
npx expo install expo-camera react-native-safe-area-context
npm install @gorhom/bottom-sheet react-native-reanimated react-native-gesture-handler

# Bare RN (дополнительно)
npm install react-native-vision-camera # альтернатива expo-camera
```

### Настройка (Expo)

app.json:
```json
{
  "expo": {
    "plugins": [
      [
        "expo-camera",
        {
          "cameraPermission": "Allow $(PRODUCT_NAME) to access your camera to take photos without leaving chat"
        }
      ]
    ]
  }
}
```

Babel (reanimated):
```js
// babel.config.js
module.exports = {
  presets: ['babel-preset-expo'],
  plugins: ['react-native-reanimated/plugin']
}
```

Root wrap:
```tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  return (
    <GestureHandlerRootView style={{flex:1}}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          {/* ... */}
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

> `SafeAreaProvider` обязателен: шторка берёт отступы через `useSafeAreaInsets()`,
> иначе кнопки налезут на Dynamic Island / Home-индикатор.

## Использование

```tsx
import { useState } from 'react';
import { InAppCameraSheet } from './components/native/InAppCameraSheet';

function ChatScreen() {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [images, setImages] = useState<string[]>([]);

  return (
    <>
      {/* Твой чат */}
      <ChatInput onCameraPress={() => setCameraOpen(true)} />

      <InAppCameraSheet
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(uri) => {
          // uri = file:///var/mobile/.../photo.jpg
          setImages(prev => [...prev, uri]);
        }}
      />
    </>
  );
}
```

## Пропсы

| Prop | Type | Default | Описание |
|------|------|---------|----------|
| `isOpen` | boolean | required | Видимость шторки |
| `onClose` | () => void | required | Закрытие (свайп, бэкдроп, X) |
| `onCapture` | (uri: string) => void | required | Возвращает локальный jpg uri |
| `snapPoints` | string[] | ["60%"] | Высоты шторки |
| `enableFlash` | boolean | true | Кнопка вспышки |
| `enableFlip` | boolean | true | Переключение фронтальная/основная |

## Особенности реализации

### 1. Скругление (iOS/Android без артефактов)

```tsx
// Внешняя карточка + внутренний клип-контейнер
<View style={{ flex: 1, borderRadius: 28, overflow: 'hidden', backgroundColor: 'black' }}>
  <View style={{ flex: 1, borderRadius: 28, overflow: 'hidden' }}>
    <CameraView style={StyleSheet.absoluteFill} facing={facing} />
  </View>
</View>
```

`overflow: hidden` + `borderRadius` на обоих уровнях обрезает нативный
`CameraView` на iOS и Android. Дополнительно шторка использует `detached` +
`bottomInset` для floating-карточки с отступами (стиль ChatGPT).

### 2. Оптимизация ресурсов (критично)

Без `setTimeout`: монтированием управляют события шторки.

```tsx
// Открытие: монтируем сразу — камера прогревается параллельно анимации
useEffect(() => {
  if (isOpen) {
    setShouldRenderCamera(true);
    sheetRef.current?.expand();
  } else {
    sheetRef.current?.close();
    if (!isSheetOpenRef.current) setShouldRenderCamera(false);
    // иначе демонтаж — в onChange(-1) по факту завершения анимации
  }
}, [isOpen]);

const handleSheetChanges = (index: number) => {
  if (index === -1) {
    // Анимация закрытия завершена: демонтируем CameraView,
    // зелёная точка гаснет, батарея не садится
    setShouldRenderCamera(false);
    onClose();
  }
};
```

Плюс `BackHandler` на Android: системная кнопка «Назад» закрывает шторку,
а не экран чата. Отступы контролов — из `useSafeAreaInsets()`.

### 3. Permissions

- `undetermined` → показываем prompt с кнопкой "Разрешить камеру" → `requestPermission()`
- `denied && !canAskAgain` → заглушка с кнопкой "Настройки" → `Linking.openSettings()` / `app-settings:`
- `granted` → рендерим CameraView

### 4. Жесты

- `enablePanDownToClose` — свайп вниз
- `BottomSheetBackdrop` с `pressBehavior="close"` — тап на затемнение
- Кнопка X — `bottomSheetRef.current?.close()`

### 5. Съемка

```tsx
const photo = await cameraRef.current.takePictureAsync({
  quality: 0.8,
  imageType: 'jpg',
  base64: false
});
onCapture(photo.uri); // file://...
```

## Web версия

Для веба в `src/components/CameraBottomSheet.tsx` аналогичная логика на `getUserMedia` + `vaul` Drawer:

- 60dvh высота, borderRadius 28px, overflow hidden + translateZ(0)
- `useCameraStream` хук управляет MediaStream lifecycle
- При закрытии `track.stop()` — индикатор камеры гаснет
- Capture через canvas → `toBlob(..., 'image/jpeg', 0.8)` → Blob + object URL
- Превью в `ChatInput` — лёгкие Blob-URL (`src/lib/imageAttachments.ts`),
  в base64 конвертируем только в момент отправки; URL отзываются через
  `URL.revokeObjectURL` при удалении/отправке/размонтировании
- Кнопки камеры и вложений дизейблятся у лимита (5 фото).
  Исключения из лимита — `CAMERA_LIMIT_BYPASS_EMAILS` в `imageAttachments.ts`

## Acceptance Criteria — чеклист

- [x] TypeScript без any
- [x] iOS/Android скругление без артефактов
- [x] 60fps через reanimated (bottom-sheet)
- [x] Возвращается корректный uri
- [x] Все состояния permissions
- [x] При закрытии зеленая точка гаснет

## Альтернатива: react-native-vision-camera v4

Если используешь vision-camera:

```tsx
import { Camera, useCameraDevice } from 'react-native-vision-camera';

const device = useCameraDevice(facing);
const camera = useRef<Camera>(null);

{device && isActive && <Camera ref={camera} device={device} isActive={isActive} photo />}
const photo = await camera.current.takePhoto({ quality: 80 });
```

Логика шторки идентична.
