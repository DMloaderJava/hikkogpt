import { useEffect, useState, type ComponentType } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
import Landing from "./pages/Landing";
import CameraOcr from "./pages/CameraOcr";

const queryClient = new QueryClient();

function AppRoutes() {
  const { user, loading } = useAuth();
  const [DevPreview, setDevPreview] = useState<ComponentType | null>(null);

  // Дев-стенд сферы по хэшу #voice-preview (см. components/dev). В production
  // ветка вырезается целиком вместе с динамическим импортом.
  useEffect(() => {
    if (!import.meta.env.DEV || window.location.hash !== "#voice-preview") return;
    void import("@/components/dev/VoiceVisualizerDemo").then((mod) =>
      setDevPreview(() => mod.VoiceVisualizerDemo)
    );
  }, []);

  if (DevPreview) return <DevPreview />;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={user ? <Index /> : <Landing />} />
      <Route path="/auth" element={user ? <Navigate to="/" replace /> : <Auth />} />
      <Route path="/camera" element={<CameraOcr />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
