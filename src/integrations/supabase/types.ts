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
      customers: {
        Row: {
          consent_form_signed: boolean
          consent_form_signed_at: string | null
          created_at: string
          email: string | null
          first_name: string
          id: string
          last_name: string | null
          last_reactivation_at: string | null
          last_service_date: string | null
          notes: string | null
          opt_in_consent: boolean
          phone_number: string
          sms_opt_in_at: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          consent_form_signed?: boolean
          consent_form_signed_at?: string | null
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          last_reactivation_at?: string | null
          last_service_date?: string | null
          notes?: string | null
          opt_in_consent?: boolean
          phone_number: string
          sms_opt_in_at?: string | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          consent_form_signed?: boolean
          consent_form_signed_at?: string | null
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          last_reactivation_at?: string | null
          last_service_date?: string | null
          notes?: string | null
          opt_in_consent?: boolean
          phone_number?: string
          sms_opt_in_at?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      excluded_numbers: {
        Row: {
          created_at: string
          id: string
          label: string | null
          phone_number: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          phone_number: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          phone_number?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      intake_rate_limits: {
        Row: {
          id: string
          ip_hash: string
          submitted_at: string
          user_id: string
        }
        Insert: {
          id?: string
          ip_hash: string
          submitted_at?: string
          user_id: string
        }
        Update: {
          id?: string
          ip_hash?: string
          submitted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_submissions: {
        Row: {
          created_at: string
          customer_business_name: string | null
          customer_email: string | null
          customer_first_name: string
          customer_last_name: string
          customer_phone: string
          id: string
          photo_urls: string[]
          responses: Json
          source: string
          status: string
          submitted_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name: string
          customer_last_name: string
          customer_phone: string
          id?: string
          photo_urls?: string[]
          responses?: Json
          source?: string
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          customer_business_name?: string | null
          customer_email?: string | null
          customer_first_name?: string
          customer_last_name?: string
          customer_phone?: string
          id?: string
          photo_urls?: string[]
          responses?: Json
          source?: string
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          created_at: string
          google_review_url: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          google_review_url?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          google_review_url?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          customer_id: string | null
          id: string
          intake_submission_id: string | null
          job_value: number | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          intake_submission_id?: string | null
          job_value?: number | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          intake_submission_id?: string | null
          job_value?: number | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_intake_submission_id_fkey"
            columns: ["intake_submission_id"]
            isOneToOne: false
            referencedRelation: "intake_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      logs: {
        Row: {
          action_type: string
          created_at: string
          customer_id: string | null
          id: string
          message_sent: string | null
          status: string
          twilio_message_sid: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          customer_id?: string | null
          id?: string
          message_sent?: string | null
          status?: string
          twilio_message_sid?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          customer_id?: string | null
          id?: string
          message_sent?: string | null
          status?: string
          twilio_message_sid?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "logs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          business_name: string
          created_at: string
          email: string | null
          id: string
          intake_enabled: boolean
          review_requests_enabled: boolean
          stripe_customer_id: string | null
          subscription_status: string
          subscription_tier: string
          tos_accepted_at: string | null
          twilio_phone_number: string | null
          twilio_phone_sid: string | null
          twilio_provisioned_at: string | null
          updated_at: string
        }
        Insert: {
          business_name?: string
          created_at?: string
          email?: string | null
          id: string
          intake_enabled?: boolean
          review_requests_enabled?: boolean
          stripe_customer_id?: string | null
          subscription_status?: string
          subscription_tier?: string
          tos_accepted_at?: string | null
          twilio_phone_number?: string | null
          twilio_phone_sid?: string | null
          twilio_provisioned_at?: string | null
          updated_at?: string
        }
        Update: {
          business_name?: string
          created_at?: string
          email?: string | null
          id?: string
          intake_enabled?: boolean
          review_requests_enabled?: boolean
          stripe_customer_id?: string | null
          subscription_status?: string
          subscription_tier?: string
          tos_accepted_at?: string | null
          twilio_phone_number?: string | null
          twilio_phone_sid?: string | null
          twilio_provisioned_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      quotes: {
        Row: {
          billing_address: string | null
          created_at: string
          customer_business_name: string | null
          customer_first_name: string
          customer_last_name: string | null
          customer_phone: string
          description: string | null
          id: string
          job_site_address: string
          job_type: string
          line_items: Json
          po_number: string | null
          status: string
          subtotal: number
          tax_amount: number
          tax_exempt: boolean
          tax_rate: number
          total_amount: number
          updated_at: string
          user_id: string
          valid_until: string | null
        }
        Insert: {
          billing_address?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_first_name: string
          customer_last_name?: string | null
          customer_phone: string
          description?: string | null
          id?: string
          job_site_address: string
          job_type?: string
          line_items?: Json
          po_number?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number
          tax_exempt?: boolean
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id: string
          valid_until?: string | null
        }
        Update: {
          billing_address?: string | null
          created_at?: string
          customer_business_name?: string | null
          customer_first_name?: string
          customer_last_name?: string | null
          customer_phone?: string
          description?: string | null
          id?: string
          job_site_address?: string
          job_type?: string
          line_items?: Json
          po_number?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number
          tax_exempt?: boolean
          tax_rate?: number
          total_amount?: number
          updated_at?: string
          user_id?: string
          valid_until?: string | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          environment: string
          id: string
          price_id: string
          product_id: string
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id: string
          product_id: string
          status?: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id?: string
          product_id?: string
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_active_subscription: {
        Args: { check_env?: string; user_uuid: string }
        Returns: boolean
      }
      has_role: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["admin", "user"],
    },
  },
} as const
