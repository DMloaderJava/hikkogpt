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

const queryClient = new QueryClient();

function AppRoutes() {
  const { user, loading } = useAuth();
  const [DevPreview, setDevPreview] = useState<ComponentType | null>(null);

  // Дев-стенды по хэшу: #voice-preview — сфера, #input-preview — строка ввода
  // (см. components/dev). В production ветка вырезается целиком вместе с
  // динамическими импортами.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (window.location.hash === "#voice-preview") {
      void import("@/components/dev/VoiceVisualizerDemo").then((mod) =>
        setDevPreview(() => mod.VoiceVisualizerDemo)
      );
    } else if (window.location.hash === "#input-preview") {
      void import("@/components/dev/ChatInputDemo").then((mod) =>
        setDevPreview(() => mod.ChatInputDemo)
      );
    }
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
