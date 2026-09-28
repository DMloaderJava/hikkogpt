export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_requests: {
        Row: {
          conflict: boolean | null
          created_at: string
          finalized_at: string | null
          finalized_error: string | null
          id: string
          ip_hash: string | null
          note: string | null
          payload: Json | null
          public_token: string | null
          reject_reason: string | null
          requester_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["request_status"]
          submitter_email: string | null
          target_id: string | null
          target_name: string | null
          turnstile_ok: boolean | null
          type: Database["public"]["Enums"]["request_type"]
          user_agent: string | null
        }
        Insert: {
          conflict?: boolean | null
          created_at?: string
          finalized_at?: string | null
          finalized_error?: string | null
          id?: string
          ip_hash?: string | null
          note?: string | null
          payload?: Json | null
          public_token?: string | null
          reject_reason?: string | null
          requester_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["request_status"]
          submitter_email?: string | null
          target_id?: string | null
          target_name?: string | null
          turnstile_ok?: boolean | null
          type: Database["public"]["Enums"]["request_type"]
          user_agent?: string | null
        }
        Update: {
          conflict?: boolean | null
          created_at?: string
          finalized_at?: string | null
          finalized_error?: string | null
          id?: string
          ip_hash?: string | null
          note?: string | null
          payload?: Json | null
          public_token?: string | null
          reject_reason?: string | null
          requester_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["request_status"]
          submitter_email?: string | null
          target_id?: string | null
          target_name?: string | null
          turnstile_ok?: boolean | null
          type?: Database["public"]["Enums"]["request_type"]
          user_agent?: string | null
        }
        Relationships: []
      }
      ads: {
        Row: {
          active: boolean
          advertiser_name: string | null
          created_at: string
          description: string | null
          expires_at: string | null
          id: string
          image_url: string | null
          link_label: string
          link_url: string
          placement: string
          title: string
        }
        Insert: {
          active?: boolean
          advertiser_name?: string | null
          created_at?: string
          description?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          link_label?: string
          link_url: string
          placement?: string
          title: string
        }
        Update: {
          active?: boolean
          advertiser_name?: string | null
          created_at?: string
          description?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          link_label?: string
          link_url?: string
          placement?: string
          title?: string
        }
        Relationships: []
      }
      chapter_voiceovers: {
        Row: {
          audio_url: string
          chapter_id: string
          created_at: string
          duration_ms: number | null
          id: string
          lines: Json
        }
        Insert: {
          audio_url: string
          chapter_id: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          lines?: Json
        }
        Update: {
          audio_url?: string
          chapter_id?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          lines?: Json
        }
        Relationships: [
          {
            foreignKeyName: "chapter_voiceovers_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: true
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
        ]
      }
      chapters: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string | null
          number: number
          published: boolean
          title_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string | null
          number: number
          published?: boolean
          title_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string | null
          number?: number
          published?: boolean
          title_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chapters_title_id_fkey"
            columns: ["title_id"]
            isOneToOne: false
            referencedRelation: "titles"
            referencedColumns: ["id"]
          },
        ]
      }
      chats: {
        Row: {
          created_at: string
          id: string
          model: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          model?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          model?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      genres: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      ip_rate_limit: {
        Row: {
          count: number
          ip_hash: string
          window_start: string
        }
        Insert: {
          count?: number
          ip_hash: string
          window_start: string
        }
        Update: {
          count?: number
          ip_hash?: string
          window_start?: string
        }
        Relationships: []
      }
      login_challenges: {
        Row: {
          admin_email: string | null
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          resolved_at: string | null
          session_id: string | null
          status: string
          token: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          admin_email?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          resolved_at?: string | null
          session_id?: string | null
          status?: string
          token: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          admin_email?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          resolved_at?: string | null
          session_id?: string | null
          status?: string
          token?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          chat_id: string
          content: string
          created_at: string
          id: string
          image_url: string | null
          role: string
        }
        Insert: {
          chat_id: string
          content?: string
          created_at?: string
          id?: string
          image_url?: string | null
          role: string
        }
        Update: {
          chat_id?: string
          content?: string
          created_at?: string
          id?: string
          image_url?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          chapter_id: string
          id: string
          image_url: string
          original_url: string | null
          page_order: number
        }
        Insert: {
          chapter_id: string
          id?: string
          image_url: string
          original_url?: string | null
          page_order: number
        }
        Update: {
          chapter_id?: string
          id?: string
          image_url?: string
          original_url?: string | null
          page_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "pages_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_log: {
        Row: {
          action: string
          created_at: string
          id: number
          key: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: never
          key: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: never
          key?: string
        }
        Relationships: []
      }
      title_genres: {
        Row: {
          genre_id: string
          title_id: string
        }
        Insert: {
          genre_id: string
          title_id: string
        }
        Update: {
          genre_id?: string
          title_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "title_genres_genre_id_fkey"
            columns: ["genre_id"]
            isOneToOne: false
            referencedRelation: "genres"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "title_genres_title_id_fkey"
            columns: ["title_id"]
            isOneToOne: false
            referencedRelation: "titles"
            referencedColumns: ["id"]
          },
        ]
      }
      titles: {
        Row: {
          author: string | null
          cover_url: string | null
          created_at: string
          description: string | null
          id: string
          published: boolean
          slug: string
          status: string
          title: string
        }
        Insert: {
          author?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          published?: boolean
          slug: string
          status?: string
          title: string
        }
        Update: {
          author?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          published?: boolean
          slug?: string
          status?: string
          title?: string
        }
        Relationships: []
      }
      user_api_keys: {
        Row: {
          ciphertext: string
          created_at: string
          iv: string
          last4: string
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ciphertext: string
          created_at?: string
          iv: string
          last4: string
          provider?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ciphertext?: string
          created_at?: string
          iv?: string
          last4?: string
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          role: string
          user_id: string
        }
        Insert: {
          role: string
          user_id: string
        }
        Update: {
          role?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_ip_rate_limit: {
        Args: { p_ip_hash: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
      cleanup_ip_rate_limit: { Args: never; Returns: undefined }
      cleanup_rate_limit_log: { Args: never; Returns: undefined }
      cleanup_rejected_submissions: { Args: never; Returns: undefined }
      create_login_challenge: {
        Args: {
          p_admin_email?: string
          p_ip?: string
          p_session_id?: string
          p_token: string
          p_ttl_minutes?: number
          p_user_agent?: string
        }
        Returns: string
      }
      has_role: {
        Args: { role_to_check: string; uid: string }
        Returns: boolean
      }
      latest_login_challenge_status: { Args: never; Returns: string }
      resolve_login_challenge: {
        Args: { p_action: string; p_token: string }
        Returns: string
      }
      slugify_title: { Args: { p_text: string }; Returns: string }
    }
    Enums: {
      request_status: "pending" | "approved" | "rejected" | "spam"
      request_type:
        | "delete_title"
        | "delete_chapter"
        | "new_chapter"
        | "ad_request"
        | "new_title"
        | "new_team"
        | "new_person"
        | "new_character"
        | "new_publisher"
        | "new_card"
        | "new_chapters"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      request_status: ["pending", "approved", "rejected", "spam"],
      request_type: [
        "delete_title",
        "delete_chapter",
        "new_chapter",
        "ad_request",
        "new_title",
        "new_team",
        "new_person",
        "new_character",
        "new_publisher",
        "new_card",
        "new_chapters",
      ],
    },
  },
} as const
