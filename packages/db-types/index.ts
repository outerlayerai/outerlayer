export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_cost_config: {
        Row: {
          cost_per_seat_usd: number
          created_at: string
          created_by: string | null
          seat_count: number
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          cost_per_seat_usd?: number
          created_at?: string
          created_by?: string | null
          seat_count?: number
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          cost_per_seat_usd?: number
          created_at?: string
          created_by?: string | null
          seat_count?: number
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_cost_config_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_cost_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ai_cost_config_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      api_key: {
        Row: {
          actor_membership_id: string | null
          allowed_env_kinds: string[] | null
          api_key_id: string
          app_id: string
          created_at: string | null
          created_by: string | null
          environment_id: string | null
          expires_at: string | null
          id: string
          is_machine: boolean
          key_prefix: string | null
          name: string
          permissions: Database["public"]["Enums"]["app_permission"][]
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          actor_membership_id?: string | null
          allowed_env_kinds?: string[] | null
          api_key_id: string
          app_id: string
          created_at?: string | null
          created_by?: string | null
          environment_id?: string | null
          expires_at?: string | null
          id?: string
          is_machine?: boolean
          key_prefix?: string | null
          name: string
          permissions?: Database["public"]["Enums"]["app_permission"][]
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          actor_membership_id?: string | null
          allowed_env_kinds?: string[] | null
          api_key_id?: string
          app_id?: string
          created_at?: string | null
          created_by?: string | null
          environment_id?: string | null
          expires_at?: string | null
          id?: string
          is_machine?: boolean
          key_prefix?: string | null
          name?: string
          permissions?: Database["public"]["Enums"]["app_permission"][]
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_key_actor_membership_id_fkey"
            columns: ["actor_membership_id"]
            isOneToOne: false
            referencedRelation: "membership"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "environment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "api_key_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "api_key_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      app: {
        Row: {
          commit_sha: string | null
          created_at: string | null
          created_by: string | null
          display_name: string | null
          entry_point: string | null
          environment_migration_done_at: string | null
          id: string
          name: string
          require_pull_request: boolean
          runtime: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          commit_sha?: string | null
          created_at?: string | null
          created_by?: string | null
          display_name?: string | null
          entry_point?: string | null
          environment_migration_done_at?: string | null
          id?: string
          name: string
          require_pull_request?: boolean
          runtime?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          commit_sha?: string | null
          created_at?: string | null
          created_by?: string | null
          display_name?: string | null
          entry_point?: string | null
          environment_migration_done_at?: string | null
          id?: string
          name?: string
          require_pull_request?: boolean
          runtime?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "app_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      app_member_role: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          custom_role_id: string | null
          id: string
          membership_id: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          custom_role_id?: string | null
          id?: string
          membership_id: string
          role: Database["public"]["Enums"]["app_role"]
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          custom_role_id?: string | null
          id?: string
          membership_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_member_role_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_member_role_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_member_role_custom_role_id_fkey"
            columns: ["custom_role_id"]
            isOneToOne: false
            referencedRelation: "custom_role"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_member_role_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "membership"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_member_role_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "app_member_role_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "app_member_role_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action_type: string
          actor_id: string | null
          actor_label: string | null
          actor_type: string
          after_state: Json | null
          before_state: Json | null
          created_at: string
          details: Json | null
          id: string
          ip_address: unknown
          prev_hash: string | null
          request_id: string | null
          row_hash: string | null
          seq: number
          target_id: string | null
          target_identifier: string | null
          target_type: string
          tenant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action_type: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: unknown
          prev_hash?: string | null
          request_id?: string | null
          row_hash?: string | null
          seq?: never
          target_id?: string | null
          target_identifier?: string | null
          target_type: string
          tenant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action_type?: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: unknown
          prev_hash?: string | null
          request_id?: string | null
          row_hash?: string | null
          seq?: never
          target_id?: string | null
          target_identifier?: string | null
          target_type?: string
          tenant_id?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      billing: {
        Row: {
          created_at: string | null
          created_by: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string
          tier_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id: string
          tier_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string
          tier_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "billing_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      context_blob: {
        Row: {
          app_id: string
          blob_sha: string
          content: string
          inserted_at: string
          size: number
          tenant_id: string
        }
        Insert: {
          app_id: string
          blob_sha: string
          content: string
          inserted_at?: string
          size: number
          tenant_id: string
        }
        Update: {
          app_id?: string
          blob_sha?: string
          content?: string
          inserted_at?: string
          size?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_blob_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_blob_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "context_blob_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      context_head: {
        Row: {
          app_id: string
          branch: string
          commit_sha: string
          snapshot_id: string
          synced_at: string
          tenant_id: string
        }
        Insert: {
          app_id: string
          branch: string
          commit_sha: string
          snapshot_id: string
          synced_at?: string
          tenant_id: string
        }
        Update: {
          app_id?: string
          branch?: string
          commit_sha?: string
          snapshot_id?: string
          synced_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_head_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_head_snapshot_app_fk"
            columns: ["snapshot_id", "app_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id", "app_id"]
          },
          {
            foreignKeyName: "context_head_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_head_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "context_head_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      context_snapshot: {
        Row: {
          app_id: string
          classifier_version: number
          commit_sha: string
          created_at: string
          excluded_counts: Json
          id: string
          tenant_id: string
        }
        Insert: {
          app_id: string
          classifier_version: number
          commit_sha: string
          created_at?: string
          excluded_counts?: Json
          id?: string
          tenant_id: string
        }
        Update: {
          app_id?: string
          classifier_version?: number
          commit_sha?: string
          created_at?: string
          excluded_counts?: Json
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_snapshot_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_snapshot_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "context_snapshot_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      context_sync_event: {
        Row: {
          app_id: string
          branch: string
          commit_message: string | null
          commit_sha: string | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          snapshot_id: string | null
          status: string
          tenant_id: string
          trigger: string
        }
        Insert: {
          app_id: string
          branch: string
          commit_message?: string | null
          commit_sha?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          snapshot_id?: string | null
          status: string
          tenant_id: string
          trigger: string
        }
        Update: {
          app_id?: string
          branch?: string
          commit_message?: string | null
          commit_sha?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          snapshot_id?: string | null
          status?: string
          tenant_id?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_sync_event_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_sync_event_snapshot_app_fk"
            columns: ["snapshot_id", "app_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id", "app_id"]
          },
          {
            foreignKeyName: "context_sync_event_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_sync_event_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "context_sync_event_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      context_tree_entry: {
        Row: {
          app_id: string
          blob_sha: string
          kind: string
          path: string
          scope_path: string
          snapshot_id: string
          tenant_id: string
        }
        Insert: {
          app_id: string
          blob_sha: string
          kind: string
          path: string
          scope_path: string
          snapshot_id: string
          tenant_id: string
        }
        Update: {
          app_id?: string
          blob_sha?: string
          kind?: string
          path?: string
          scope_path?: string
          snapshot_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "context_tree_entry_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_tree_entry_snapshot_app_fk"
            columns: ["snapshot_id", "app_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id", "app_id"]
          },
          {
            foreignKeyName: "context_tree_entry_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "context_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "context_tree_entry_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "context_tree_entry_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      custom_role: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "custom_role_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custom_role_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "custom_role_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_role_permission: {
        Row: {
          custom_role_id: string
          id: string
          permission: Database["public"]["Enums"]["app_permission"]
        }
        Insert: {
          custom_role_id: string
          id?: string
          permission: Database["public"]["Enums"]["app_permission"]
        }
        Update: {
          custom_role_id?: string
          id?: string
          permission?: Database["public"]["Enums"]["app_permission"]
        }
        Relationships: [
          {
            foreignKeyName: "custom_role_permission_custom_role_id_fkey"
            columns: ["custom_role_id"]
            isOneToOne: false
            referencedRelation: "custom_role"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          description: string | null
          global_time_range: string
          id: string
          is_default: boolean
          layout: Json
          name: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          user_id: string | null
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          global_time_range?: string
          id?: string
          is_default?: boolean
          layout?: Json
          name: string
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          user_id?: string | null
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          global_time_range?: string
          id?: string
          is_default?: boolean
          layout?: Json
          name?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dashboard_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dashboard_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "dashboard_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "dashboard_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dashboard_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_widget: {
        Row: {
          created_at: string
          created_by: string | null
          dashboard_id: string
          environment_config: Json | null
          filters: Json
          group_by: string | null
          id: string
          metric: string
          score_name: string | null
          score_name_b: string | null
          sort_order: number
          tenant_id: string
          time_granularity: string
          title: string
          updated_at: string | null
          updated_by: string | null
          visualization: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dashboard_id: string
          environment_config?: Json | null
          filters?: Json
          group_by?: string | null
          id?: string
          metric: string
          score_name?: string | null
          score_name_b?: string | null
          sort_order?: number
          tenant_id: string
          time_granularity?: string
          title: string
          updated_at?: string | null
          updated_by?: string | null
          visualization?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dashboard_id?: string
          environment_config?: Json | null
          filters?: Json
          group_by?: string | null
          id?: string
          metric?: string
          score_name?: string | null
          score_name_b?: string | null
          sort_order?: number
          tenant_id?: string
          time_granularity?: string
          title?: string
          updated_at?: string | null
          updated_by?: string | null
          visualization?: string
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_widget_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dashboard_widget_dashboard_id_fkey"
            columns: ["dashboard_id"]
            isOneToOne: false
            referencedRelation: "dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dashboard_widget_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "dashboard_widget_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      env_var: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          environment_id: string | null
          id: string
          key: string
          target_kind: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          vault_secret_id: string
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          environment_id?: string | null
          id?: string
          key: string
          target_kind?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          vault_secret_id: string
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          environment_id?: string | null
          id?: string
          key?: string
          target_kind?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          vault_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "env_var_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "env_var_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "env_var_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "environment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "env_var_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "env_var_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "env_var_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      environment: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          current_commit_sha: string | null
          current_version: number
          epoch: number
          fly_app_name: string | null
          fly_machine_id: string | null
          id: string
          is_default: boolean
          is_ephemeral: boolean
          name: string
          source_branch: string | null
          source_pr_number: number | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          current_commit_sha?: string | null
          current_version?: number
          epoch?: number
          fly_app_name?: string | null
          fly_machine_id?: string | null
          id?: string
          is_default?: boolean
          is_ephemeral?: boolean
          name: string
          source_branch?: string | null
          source_pr_number?: number | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          current_commit_sha?: string | null
          current_version?: number
          epoch?: number
          fly_app_name?: string | null
          fly_machine_id?: string | null
          id?: string
          is_default?: boolean
          is_ephemeral?: boolean
          name?: string
          source_branch?: string | null
          source_pr_number?: number | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "environment_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "environment_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "environment_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flag: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          is_enabled: boolean | null
          key: string
          rollout_percentage: number | null
          strategy: Database["public"]["Enums"]["flag_strategy"]
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          is_enabled?: boolean | null
          key: string
          rollout_percentage?: number | null
          strategy?: Database["public"]["Enums"]["flag_strategy"]
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          is_enabled?: boolean | null
          key?: string
          rollout_percentage?: number | null
          strategy?: Database["public"]["Enums"]["flag_strategy"]
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_flag_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_flag_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flag_override: {
        Row: {
          created_at: string | null
          created_by: string | null
          flag_id: string
          id: string
          is_enabled: boolean
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          flag_id: string
          id?: string
          is_enabled: boolean
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          flag_id?: string
          id?: string
          is_enabled?: boolean
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_flag_override_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_flag_override_flag_id_fkey"
            columns: ["flag_id"]
            isOneToOne: false
            referencedRelation: "feature_flag"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_flag_override_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "feature_flag_override_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      git_branch: {
        Row: {
          app_id: string
          branch_name: string | null
          created_at: string | null
          created_by: string | null
          id: string
          repo: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          app_id: string
          branch_name?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          repo?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          app_id?: string
          branch_name?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          repo?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "git_branch_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "git_branch_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "git_branch_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_branch_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "github_branch_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      git_connection: {
        Row: {
          app_id: string
          created_at: string | null
          created_by: string | null
          id: string
          installation_id: number | null
          pr_comments_enabled: boolean
          provider: string
          repository: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          webhook_id: string | null
          webhook_secret: string | null
        }
        Insert: {
          app_id: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          installation_id?: number | null
          pr_comments_enabled?: boolean
          provider?: string
          repository?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          webhook_id?: string | null
          webhook_secret?: string | null
        }
        Update: {
          app_id?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          installation_id?: number | null
          pr_comments_enabled?: boolean
          provider?: string
          repository?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          webhook_id?: string | null
          webhook_secret?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "git_connection_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "git_connection_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "git_connection_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: true
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "git_connection_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "git_connection_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      membership: {
        Row: {
          accepted_at: string | null
          created_at: string
          created_by: string | null
          custom_role_id: string | null
          expires_at: string | null
          id: string
          invited_at: string | null
          invited_by: string | null
          is_app_scoped: boolean
          role: Database["public"]["Enums"]["app_role"]
          status: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          custom_role_id?: string | null
          expires_at?: string | null
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_app_scoped?: boolean
          role: Database["public"]["Enums"]["app_role"]
          status?: string
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          custom_role_id?: string | null
          expires_at?: string | null
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_app_scoped?: boolean
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_custom_role_id_fkey"
            columns: ["custom_role_id"]
            isOneToOne: false
            referencedRelation: "custom_role"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "membership_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      notification: {
        Row: {
          created_at: string | null
          id: string
          message: string
          read: boolean | null
          tenant_id: string
          type: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          message: string
          read?: boolean | null
          tenant_id: string
          type?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          message?: string
          read?: boolean | null
          tenant_id?: string
          type?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "notification_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_role_permissions: {
        Row: {
          id: string
          permission: Database["public"]["Enums"]["platform_permission"]
          role: Database["public"]["Enums"]["platform_role"]
        }
        Insert: {
          id?: string
          permission: Database["public"]["Enums"]["platform_permission"]
          role: Database["public"]["Enums"]["platform_role"]
        }
        Update: {
          id?: string
          permission?: Database["public"]["Enums"]["platform_permission"]
          role?: Database["public"]["Enums"]["platform_role"]
        }
        Relationships: []
      }
      platform_user_role: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          role: Database["public"]["Enums"]["platform_role"]
          updated_at: string | null
          updated_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["platform_role"]
          updated_at?: string | null
          updated_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["platform_role"]
          updated_at?: string | null
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_user_role_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_user_role_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_user_role_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      pr_session_comment: {
        Row: {
          claimed_at: string | null
          created_at: string
          github_comment_id: number | null
          id: string
          last_body_hash: string
          last_posted_at: string | null
          needs_refresh: boolean
          pr_number: number
          repository: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          github_comment_id?: number | null
          id?: string
          last_body_hash?: string
          last_posted_at?: string | null
          needs_refresh?: boolean
          pr_number: number
          repository: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          github_comment_id?: number | null
          id?: string
          last_body_hash?: string
          last_posted_at?: string | null
          needs_refresh?: boolean
          pr_number?: number
          repository?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pr_session_comment_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      profile: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          github_username: string | null
          id: string
          last_active_tenant_id: string | null
          name: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          github_username?: string | null
          id: string
          last_active_tenant_id?: string | null
          name?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          github_username?: string | null
          id?: string
          last_active_tenant_id?: string | null
          name?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_last_active_tenant_id_fkey"
            columns: ["last_active_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      pull_request: {
        Row: {
          additions: number | null
          app_id: string
          base_branch: string
          changed_files: number | null
          closed_at: string | null
          comment_id: number | null
          created_at: string
          created_by: string | null
          deletions: number | null
          environment_id: string | null
          first_approved_at: string | null
          first_ci_at: string | null
          first_ci_sha: string | null
          first_ci_status: string | null
          first_review_at: string | null
          head_branch: string
          head_sha: string | null
          id: string
          merged_at: string | null
          opened_at: string | null
          pr_number: number
          provider: string
          ready_for_review_at: string | null
          reopen_count: number
          reverted_at: string | null
          state: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          url: string | null
        }
        Insert: {
          additions?: number | null
          app_id: string
          base_branch: string
          changed_files?: number | null
          closed_at?: string | null
          comment_id?: number | null
          created_at?: string
          created_by?: string | null
          deletions?: number | null
          environment_id?: string | null
          first_approved_at?: string | null
          first_ci_at?: string | null
          first_ci_sha?: string | null
          first_ci_status?: string | null
          first_review_at?: string | null
          head_branch: string
          head_sha?: string | null
          id?: string
          merged_at?: string | null
          opened_at?: string | null
          pr_number: number
          provider?: string
          ready_for_review_at?: string | null
          reopen_count?: number
          reverted_at?: string | null
          state?: string
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          url?: string | null
        }
        Update: {
          additions?: number | null
          app_id?: string
          base_branch?: string
          changed_files?: number | null
          closed_at?: string | null
          comment_id?: number | null
          created_at?: string
          created_by?: string | null
          deletions?: number | null
          environment_id?: string | null
          first_approved_at?: string | null
          first_ci_at?: string | null
          first_ci_sha?: string | null
          first_ci_status?: string | null
          first_review_at?: string | null
          head_branch?: string
          head_sha?: string | null
          id?: string
          merged_at?: string | null
          opened_at?: string | null
          pr_number?: number
          provider?: string
          ready_for_review_at?: string | null
          reopen_count?: number
          reverted_at?: string | null
          state?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pull_request_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pull_request_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pull_request_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "environment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pull_request_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "pull_request_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "pull_request_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      pull_request_session: {
        Row: {
          app_id: string
          first_linked_at: string
          git_branch: string
          id: string
          last_reconciled_at: string
          method: string
          pr_number: number
          session_id: string
          tenant_id: string
          trace_id: string
          verification: string
        }
        Insert: {
          app_id: string
          first_linked_at?: string
          git_branch?: string
          id?: string
          last_reconciled_at?: string
          method: string
          pr_number: number
          session_id?: string
          tenant_id: string
          trace_id: string
          verification?: string
        }
        Update: {
          app_id?: string
          first_linked_at?: string
          git_branch?: string
          id?: string
          last_reconciled_at?: string
          method?: string
          pr_number?: number
          session_id?: string
          tenant_id?: string
          trace_id?: string
          verification?: string
        }
        Relationships: [
          {
            foreignKeyName: "pull_request_session_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pull_request_session_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "pull_request_session_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          id: string
          permission: Database["public"]["Enums"]["app_permission"]
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          id?: string
          permission: Database["public"]["Enums"]["app_permission"]
          role: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          id?: string
          permission?: Database["public"]["Enums"]["app_permission"]
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
      saved_trace_filters: {
        Row: {
          app_id: string
          created_at: string
          created_by: string | null
          filter_config: Json
          id: string
          name: string
          page: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          user_id: string
        }
        Insert: {
          app_id: string
          created_at?: string
          created_by?: string | null
          filter_config: Json
          id?: string
          name: string
          page?: string
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          user_id: string
        }
        Update: {
          app_id?: string
          created_at?: string
          created_by?: string | null
          filter_config?: Json
          id?: string
          name?: string
          page?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_trace_filters_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_trace_filters_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "saved_trace_filters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "saved_trace_filters_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      sso_audit_log: {
        Row: {
          created_at: string
          email: string | null
          error_message: string | null
          event_type: string
          id: string
          ip_address: unknown
          sso_config_id: string
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          ip_address?: unknown
          sso_config_id: string
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          ip_address?: unknown
          sso_config_id?: string
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sso_audit_log_sso_config_id_fkey"
            columns: ["sso_config_id"]
            isOneToOne: false
            referencedRelation: "sso_config"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      sso_config: {
        Row: {
          allowed_domains: string[]
          created_at: string
          created_by: string | null
          enforcement_enabled: boolean
          entity_id: string | null
          id: string
          is_active: boolean
          last_validated_at: string | null
          metadata_url: string | null
          supabase_provider_id: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          allowed_domains?: string[]
          created_at?: string
          created_by?: string | null
          enforcement_enabled?: boolean
          entity_id?: string | null
          id?: string
          is_active?: boolean
          last_validated_at?: string | null
          metadata_url?: string | null
          supabase_provider_id?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          allowed_domains?: string[]
          created_at?: string
          created_by?: string | null
          enforcement_enabled?: boolean
          entity_id?: string | null
          id?: string
          is_active?: boolean
          last_validated_at?: string | null
          metadata_url?: string | null
          supabase_provider_id?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sso_config_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "sso_config_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      sso_identity: {
        Row: {
          created_at: string
          external_subject_id: string
          first_login_at: string
          id: string
          idp_issuer: string | null
          last_login_at: string
          sso_config_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          external_subject_id: string
          first_login_at?: string
          id?: string
          idp_issuer?: string | null
          last_login_at?: string
          sso_config_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          external_subject_id?: string
          first_login_at?: string
          id?: string
          idp_issuer?: string | null
          last_login_at?: string
          sso_config_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_identity_sso_config_id_fkey"
            columns: ["sso_config_id"]
            isOneToOne: false
            referencedRelation: "sso_config"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_identity_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      temp_access_grant: {
        Row: {
          created_at: string
          created_by: string
          customer_permission_confirmed: boolean
          expires_at: string
          id: string
          reason: string | null
          revoked_at: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          customer_permission_confirmed?: boolean
          expires_at: string
          id?: string
          reason?: string | null
          revoked_at?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          customer_permission_confirmed?: boolean
          expires_at?: string
          id?: string
          reason?: string | null
          revoked_at?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "temp_access_grant_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "temp_access_grant_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "temp_access_grant_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant: {
        Row: {
          agent_capture_tier: string
          company_name: string
          created_at: string | null
          created_by: string | null
          first_trace_at: string | null
          organization_name: string
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          agent_capture_tier?: string
          company_name: string
          created_at?: string | null
          created_by?: string | null
          first_trace_at?: string | null
          organization_name: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          agent_capture_tier?: string
          company_name?: string
          created_at?: string | null
          created_by?: string | null
          first_trace_at?: string | null
          organization_name?: string
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      tenant_entitlement_override: {
        Row: {
          created_at: string
          created_by: string | null
          entitlement_key: string
          id: string
          override_reason: string | null
          tenant_id: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entitlement_key: string
          id?: string
          override_reason?: string | null
          tenant_id: string
          updated_at?: string | null
          updated_by?: string | null
          value: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entitlement_key?: string
          id?: string
          override_reason?: string | null
          tenant_id?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tenant_entitlement_override_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_entitlement_override_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "tenant_entitlement_override_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      terms_agreement: {
        Row: {
          agreed_at: string
          consent_type: string
          created_at: string
          created_by: string | null
          id: string
          ip_address: string | null
          terms_version: string
          updated_at: string | null
          updated_by: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          agreed_at?: string
          consent_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          ip_address?: string | null
          terms_version: string
          updated_at?: string | null
          updated_by?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          agreed_at?: string
          consent_type?: string
          created_at?: string
          created_by?: string | null
          id?: string
          ip_address?: string | null
          terms_version?: string
          updated_at?: string | null
          updated_by?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "terms_agreement_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "terms_agreement_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "terms_agreement_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      user_git_identity: {
        Row: {
          access_token: string | null
          created_at: string | null
          email: string | null
          id: string
          profile_id: string
          provider: string
          provider_user_id: string | null
          refresh_token: string | null
          tenant_id: string
          token_expires_at: string | null
          updated_at: string | null
          username: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          profile_id: string
          provider: string
          provider_user_id?: string | null
          refresh_token?: string | null
          tenant_id: string
          token_expires_at?: string | null
          updated_at?: string | null
          username: string
        }
        Update: {
          access_token?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          profile_id?: string
          provider?: string
          provider_user_id?: string | null
          refresh_token?: string | null
          tenant_id?: string
          token_expires_at?: string | null
          updated_at?: string | null
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_git_identity_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_git_identity_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
      worker_run: {
        Row: {
          agent: string
          app_id: string
          attachments: Json
          base_branch: string
          branch_name: string | null
          completed_at: string | null
          cost_usd: number | null
          created_at: string
          created_by: string | null
          dispatch: string
          duration_ms: number | null
          environment_id: string | null
          error_message: string | null
          failure_code: string | null
          heartbeat_at: string | null
          id: string
          machine_id: string | null
          model: string | null
          num_turns: number | null
          outcome: string | null
          pr_number: number | null
          pr_url: string | null
          raw_log: string | null
          started_at: string | null
          status: string
          task_prompt: string
          tenant_id: string
          turn_index: number
          updated_at: string | null
          wall_clock_cap_s: number
          workspace_id: string | null
        }
        Insert: {
          agent: string
          app_id: string
          attachments?: Json
          base_branch?: string
          branch_name?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          dispatch?: string
          duration_ms?: number | null
          environment_id?: string | null
          error_message?: string | null
          failure_code?: string | null
          heartbeat_at?: string | null
          id?: string
          machine_id?: string | null
          model?: string | null
          num_turns?: number | null
          outcome?: string | null
          pr_number?: number | null
          pr_url?: string | null
          raw_log?: string | null
          started_at?: string | null
          status?: string
          task_prompt: string
          tenant_id: string
          turn_index?: number
          updated_at?: string | null
          wall_clock_cap_s?: number
          workspace_id?: string | null
        }
        Update: {
          agent?: string
          app_id?: string
          attachments?: Json
          base_branch?: string
          branch_name?: string | null
          completed_at?: string | null
          cost_usd?: number | null
          created_at?: string
          created_by?: string | null
          dispatch?: string
          duration_ms?: number | null
          environment_id?: string | null
          error_message?: string | null
          failure_code?: string | null
          heartbeat_at?: string | null
          id?: string
          machine_id?: string | null
          model?: string | null
          num_turns?: number | null
          outcome?: string | null
          pr_number?: number | null
          pr_url?: string | null
          raw_log?: string | null
          started_at?: string | null
          status?: string
          task_prompt?: string
          tenant_id?: string
          turn_index?: number
          updated_at?: string | null
          wall_clock_cap_s?: number
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_run_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_run_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_run_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "environment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_run_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "worker_run_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "worker_run_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "worker_workspace"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_run_event: {
        Row: {
          app_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          seq: number
          tenant_id: string
          worker_run_id: string
        }
        Insert: {
          app_id: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          seq: number
          tenant_id: string
          worker_run_id: string
        }
        Update: {
          app_id?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          seq?: number
          tenant_id?: string
          worker_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_run_event_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_run_event_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "worker_run_event_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "worker_run_event_worker_run_id_fkey"
            columns: ["worker_run_id"]
            isOneToOne: false
            referencedRelation: "worker_run"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_workspace: {
        Row: {
          agent: string
          app_id: string
          base_branch: string
          created_at: string
          created_by: string | null
          current_run_id: string | null
          environment_id: string | null
          failure_reason: string | null
          id: string
          idle_ttl_s: number
          last_active_at: string | null
          machine_ref: string | null
          model: string | null
          session_ref: string | null
          status: string
          substrate: string
          tenant_id: string
          updated_at: string | null
          work_branch: string | null
          workspace_ref: string | null
        }
        Insert: {
          agent: string
          app_id: string
          base_branch?: string
          created_at?: string
          created_by?: string | null
          current_run_id?: string | null
          environment_id?: string | null
          failure_reason?: string | null
          id?: string
          idle_ttl_s?: number
          last_active_at?: string | null
          machine_ref?: string | null
          model?: string | null
          session_ref?: string | null
          status?: string
          substrate?: string
          tenant_id: string
          updated_at?: string | null
          work_branch?: string | null
          workspace_ref?: string | null
        }
        Update: {
          agent?: string
          app_id?: string
          base_branch?: string
          created_at?: string
          created_by?: string | null
          current_run_id?: string | null
          environment_id?: string | null
          failure_reason?: string | null
          id?: string
          idle_ttl_s?: number
          last_active_at?: string | null
          machine_ref?: string | null
          model?: string | null
          session_ref?: string | null
          status?: string
          substrate?: string
          tenant_id?: string
          updated_at?: string | null
          work_branch?: string | null
          workspace_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_workspace_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_workspace_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_workspace_environment_id_fkey"
            columns: ["environment_id"]
            isOneToOne: false
            referencedRelation: "environment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_workspace_tenant_app_fk"
            columns: ["tenant_id", "app_id"]
            isOneToOne: false
            referencedRelation: "app"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "worker_workspace_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant"
            referencedColumns: ["tenant_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      app_authorize: {
        Args: {
          requested_permission: Database["public"]["Enums"]["app_permission"]
          target_app_id: string
        }
        Returns: boolean
      }
      audit_log_compute_hash: {
        Args: {
          p_prev: string
          r: Database["public"]["Tables"]["audit_log"]["Row"]
        }
        Returns: string
      }
      authorize: {
        Args: {
          requested_permission: Database["public"]["Enums"]["app_permission"]
        }
        Returns: boolean
      }
      change_member_role_transaction: {
        Args: {
          p_actor_id: string
          p_custom_role_id?: string
          p_ip_address?: unknown
          p_new_role?: string
          p_request_id?: string
          p_target_user_id: string
          p_tenant_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      change_user_password: {
        Args: { current_plain_password: string; new_plain_password: string }
        Returns: Json
      }
      cleanup_expired_temp_access: { Args: never; Returns: Json }
      create_context_snapshot: {
        Args: {
          p_app_id: string
          p_blobs: Json
          p_branch: string
          p_classifier_version: number
          p_commit_sha: string
          p_entries: Json
          p_excluded_counts?: Json
          p_tenant_id: string
        }
        Returns: string
      }
      create_organization_transaction: {
        Args: {
          p_company_name: string
          p_organization_name: string
          p_stripe_customer_id?: string
          p_tier_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      delete_secret: { Args: { secret_name: string }; Returns: undefined }
      get_claim: { Args: { claim: string; uid: string }; Returns: Json }
      get_current_user_app_permissions: {
        Args: { target_app_id: string }
        Returns: Database["public"]["Enums"]["app_permission"][]
      }
      grant_temp_access_transaction: {
        Args: {
          p_admin_user_id: string
          p_customer_permission_confirmed: boolean
          p_expires_at: string
          p_reason: string
          p_tenant_id: string
        }
        Returns: string
      }
      insert_secret: { Args: { name: string; secret: string }; Returns: string }
      invite_existing_user_transaction: {
        Args: {
          p_expires_at: string
          p_invited_at: string
          p_invited_by: string
          p_ip_address?: unknown
          p_request_id?: string
          p_role: string
          p_tenant_id: string
          p_user_agent?: string
          p_user_id: string
        }
        Returns: string
      }
      invite_new_user_transaction: {
        Args: {
          p_email: string
          p_expires_at: string
          p_invited_at: string
          p_invited_by: string
          p_ip_address?: unknown
          p_name: string
          p_request_id?: string
          p_role: string
          p_tenant_id: string
          p_user_agent?: string
          p_user_id: string
        }
        Returns: string
      }
      is_claims_admin: { Args: never; Returns: boolean }
      platform_admin_delete_tenant: {
        Args: { p_tenant_id: string }
        Returns: undefined
      }
      read_secret: { Args: { secret_name: string }; Returns: string }
      remove_member_transaction: {
        Args: {
          p_actor_id: string
          p_ip_address?: unknown
          p_request_id?: string
          p_target_user_id: string
          p_tenant_id: string
          p_user_agent?: string
        }
        Returns: Json
      }
      set_api_key_secret: {
        Args: {
          p_api_key_id: string
          p_key_digest: string
          p_pepper_version: number
        }
        Returns: undefined
      }
      set_claim: {
        Args: { claim: string; uid: string; value: Json }
        Returns: string
      }
      tenant_id: { Args: never; Returns: string }
      update_secret: {
        Args: { secret: string; secret_name: string }
        Returns: boolean
      }
      verify_api_key: { Args: { p_key_digest: string }; Returns: Json }
      verify_audit_log_chain: {
        Args: never
        Returns: {
          bad_seq: number
          reason: string
        }[]
      }
    }
    Enums: {
      app_permission:
        | "app.read"
        | "app.insert"
        | "app.update"
        | "app.delete"
        | "profile.read"
        | "profile.insert"
        | "profile.update"
        | "profile.delete"
        | "api_key.read"
        | "api_key.insert"
        | "api_key.update"
        | "api_key.delete"
        | "tenant.read"
        | "tenant.update"
        | "billing.read"
        | "billing.update"
        | "billing.insert"
        | "git_connection.read"
        | "git_connection.insert"
        | "git_connection.update"
        | "git_connection.delete"
        | "git_branch.read"
        | "git_branch.insert"
        | "git_branch.update"
        | "git_branch.delete"
        | "dashboard.read"
        | "dashboard.insert"
        | "dashboard.update"
        | "dashboard.delete"
        | "app_member_role.read"
        | "app_member_role.insert"
        | "app_member_role.update"
        | "app_member_role.delete"
        | "sso_config.read"
        | "sso_config.insert"
        | "sso_config.update"
        | "sso_config.delete"
        | "custom_role.read"
        | "custom_role.insert"
        | "custom_role.update"
        | "custom_role.delete"
        | "trace.read"
        | "experiment.read"
        | "env_var.read"
        | "env_var.insert"
        | "env_var.update"
        | "env_var.delete"
        | "trace.write"
        | "score.read"
        | "score.write"
        | "score.delete"
        | "span.read"
        | "session.read"
        | "metrics.read"
        | "environment.read"
        | "environment.insert"
        | "environment.update"
        | "environment.delete"
        | "environment.promote"
        | "app_policy.update"
        | "audit_log.read"
        | "context.read"
        | "context.insert"
        | "context.update"
        | "context.delete"
        | "agents.sessions.self.read"
        | "agents.sessions.team.read"
        | "agents.settings.write"
        | "worker_run.read"
        | "worker_run.insert"
        | "worker_run.update"
        | "worker_run.delete"
        | "ai_cost_config.read"
        | "ai_cost_config.insert"
        | "ai_cost_config.update"
        | "ai_cost_config.delete"
        | "membership.read"
        | "membership.insert"
        | "membership.update"
        | "membership.delete"
      app_role: "admin" | "write" | "read" | "disabled" | "owner"
      flag_strategy: "global" | "random" | "targeted" | "percentage"
      platform_permission:
        | "platform.org.read"
        | "platform.org.delete"
        | "platform.user.read"
        | "platform.user.delete"
        | "platform.temp_access.grant"
        | "platform.flag.manage"
        | "platform.audit.read"
        | "platform.changelog.read"
        | "platform.changelog.write"
        | "platform.changelog.delete"
        | "platform.entitlement.read"
        | "platform.entitlement.write"
        | "platform.entitlement.delete"
        | "platform.dora.read"
        | "platform.alert_agent_config.read"
        | "platform.alert_agent_config.write"
        | "platform.alert_agent_config.update"
        | "platform.alert_agent_config.delete"
        | "platform.alert_agent_run.read"
        | "platform.alert_agent_run.write"
        | "platform.sso_config.read"
        | "platform.environment.read"
        | "platform.promotion.intervene"
      platform_role: "platform_admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  storage: {
    Tables: {
      buckets: {
        Row: {
          allowed_mime_types: string[] | null
          avif_autodetection: boolean | null
          created_at: string | null
          file_size_limit: number | null
          id: string
          name: string
          owner: string | null
          owner_id: string | null
          public: boolean | null
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string | null
        }
        Insert: {
          allowed_mime_types?: string[] | null
          avif_autodetection?: boolean | null
          created_at?: string | null
          file_size_limit?: number | null
          id: string
          name: string
          owner?: string | null
          owner_id?: string | null
          public?: boolean | null
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string | null
        }
        Update: {
          allowed_mime_types?: string[] | null
          avif_autodetection?: boolean | null
          created_at?: string | null
          file_size_limit?: number | null
          id?: string
          name?: string
          owner?: string | null
          owner_id?: string | null
          public?: boolean | null
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string | null
        }
        Relationships: []
      }
      buckets_analytics: {
        Row: {
          created_at: string
          deleted_at: string | null
          format: string
          id: string
          name: string
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          format?: string
          id?: string
          name: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          format?: string
          id?: string
          name?: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Relationships: []
      }
      buckets_vectors: {
        Row: {
          created_at: string
          id: string
          type: Database["storage"]["Enums"]["buckettype"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          type?: Database["storage"]["Enums"]["buckettype"]
          updated_at?: string
        }
        Relationships: []
      }
      iceberg_namespaces: {
        Row: {
          bucket_name: string
          catalog_id: string
          created_at: string
          id: string
          metadata: Json
          name: string
          updated_at: string
        }
        Insert: {
          bucket_name: string
          catalog_id: string
          created_at?: string
          id?: string
          metadata?: Json
          name: string
          updated_at?: string
        }
        Update: {
          bucket_name?: string
          catalog_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iceberg_namespaces_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "buckets_analytics"
            referencedColumns: ["id"]
          },
        ]
      }
      iceberg_tables: {
        Row: {
          bucket_name: string
          catalog_id: string
          created_at: string
          id: string
          location: string
          name: string
          namespace_id: string
          remote_table_id: string | null
          shard_id: string | null
          shard_key: string | null
          updated_at: string
        }
        Insert: {
          bucket_name: string
          catalog_id: string
          created_at?: string
          id?: string
          location: string
          name: string
          namespace_id: string
          remote_table_id?: string | null
          shard_id?: string | null
          shard_key?: string | null
          updated_at?: string
        }
        Update: {
          bucket_name?: string
          catalog_id?: string
          created_at?: string
          id?: string
          location?: string
          name?: string
          namespace_id?: string
          remote_table_id?: string | null
          shard_id?: string | null
          shard_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iceberg_tables_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "buckets_analytics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iceberg_tables_namespace_id_fkey"
            columns: ["namespace_id"]
            isOneToOne: false
            referencedRelation: "iceberg_namespaces"
            referencedColumns: ["id"]
          },
        ]
      }
      migrations: {
        Row: {
          executed_at: string | null
          hash: string
          id: number
          name: string
        }
        Insert: {
          executed_at?: string | null
          hash: string
          id: number
          name: string
        }
        Update: {
          executed_at?: string | null
          hash?: string
          id?: number
          name?: string
        }
        Relationships: []
      }
      objects: {
        Row: {
          bucket_id: string | null
          created_at: string | null
          id: string
          last_accessed_at: string | null
          level: number | null
          metadata: Json | null
          name: string | null
          owner: string | null
          owner_id: string | null
          path_tokens: string[] | null
          updated_at: string | null
          user_metadata: Json | null
          version: string | null
        }
        Insert: {
          bucket_id?: string | null
          created_at?: string | null
          id?: string
          last_accessed_at?: string | null
          level?: number | null
          metadata?: Json | null
          name?: string | null
          owner?: string | null
          owner_id?: string | null
          path_tokens?: string[] | null
          updated_at?: string | null
          user_metadata?: Json | null
          version?: string | null
        }
        Update: {
          bucket_id?: string | null
          created_at?: string | null
          id?: string
          last_accessed_at?: string | null
          level?: number | null
          metadata?: Json | null
          name?: string | null
          owner?: string | null
          owner_id?: string | null
          path_tokens?: string[] | null
          updated_at?: string | null
          user_metadata?: Json | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "objects_bucketId_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
        ]
      }
      prefixes: {
        Row: {
          bucket_id: string
          created_at: string | null
          level: number
          name: string
          updated_at: string | null
        }
        Insert: {
          bucket_id: string
          created_at?: string | null
          level?: number
          name: string
          updated_at?: string | null
        }
        Update: {
          bucket_id?: string
          created_at?: string | null
          level?: number
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prefixes_bucketId_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
        ]
      }
      s3_multipart_uploads: {
        Row: {
          bucket_id: string
          created_at: string
          id: string
          in_progress_size: number
          key: string
          owner_id: string | null
          upload_signature: string
          user_metadata: Json | null
          version: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          id: string
          in_progress_size?: number
          key: string
          owner_id?: string | null
          upload_signature: string
          user_metadata?: Json | null
          version: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          id?: string
          in_progress_size?: number
          key?: string
          owner_id?: string | null
          upload_signature?: string
          user_metadata?: Json | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "s3_multipart_uploads_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
        ]
      }
      s3_multipart_uploads_parts: {
        Row: {
          bucket_id: string
          created_at: string
          etag: string
          id: string
          key: string
          owner_id: string | null
          part_number: number
          size: number
          upload_id: string
          version: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          etag: string
          id?: string
          key: string
          owner_id?: string | null
          part_number: number
          size?: number
          upload_id: string
          version: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          etag?: string
          id?: string
          key?: string
          owner_id?: string | null
          part_number?: number
          size?: number
          upload_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "s3_multipart_uploads_parts_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "s3_multipart_uploads_parts_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "s3_multipart_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      vector_indexes: {
        Row: {
          bucket_id: string
          created_at: string
          data_type: string
          dimension: number
          distance_metric: string
          id: string
          metadata_configuration: Json | null
          name: string
          updated_at: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          data_type: string
          dimension: number
          distance_metric: string
          id?: string
          metadata_configuration?: Json | null
          name: string
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          data_type?: string
          dimension?: number
          distance_metric?: string
          id?: string
          metadata_configuration?: Json | null
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vector_indexes_bucket_id_fkey"
            columns: ["bucket_id"]
            isOneToOne: false
            referencedRelation: "buckets_vectors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_prefixes: {
        Args: { _bucket_id: string; _name: string }
        Returns: undefined
      }
      can_insert_object: {
        Args: { bucketid: string; metadata: Json; name: string; owner: string }
        Returns: undefined
      }
      delete_leaf_prefixes: {
        Args: { bucket_ids: string[]; names: string[] }
        Returns: undefined
      }
      delete_prefix: {
        Args: { _bucket_id: string; _name: string }
        Returns: boolean
      }
      extension: { Args: { name: string }; Returns: string }
      filename: { Args: { name: string }; Returns: string }
      foldername: { Args: { name: string }; Returns: string[] }
      get_level: { Args: { name: string }; Returns: number }
      get_prefix: { Args: { name: string }; Returns: string }
      get_prefixes: { Args: { name: string }; Returns: string[] }
      get_size_by_bucket: {
        Args: never
        Returns: {
          bucket_id: string
          size: number
        }[]
      }
      list_multipart_uploads_with_delimiter: {
        Args: {
          bucket_id: string
          delimiter_param: string
          max_keys?: number
          next_key_token?: string
          next_upload_token?: string
          prefix_param: string
        }
        Returns: {
          created_at: string
          id: string
          key: string
        }[]
      }
      list_objects_with_delimiter: {
        Args: {
          bucket_id: string
          delimiter_param: string
          max_keys?: number
          next_token?: string
          prefix_param: string
          start_after?: string
        }
        Returns: {
          id: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      lock_top_prefixes: {
        Args: { bucket_ids: string[]; names: string[] }
        Returns: undefined
      }
      operation: { Args: never; Returns: string }
      search:
        | {
            Args: {
              bucketname: string
              levels?: number
              limits?: number
              offsets?: number
              prefix: string
            }
            Returns: {
              created_at: string
              id: string
              last_accessed_at: string
              metadata: Json
              name: string
              updated_at: string
            }[]
          }
        | {
            Args: {
              bucketname: string
              levels?: number
              limits?: number
              offsets?: number
              prefix: string
              search?: string
              sortcolumn?: string
              sortorder?: string
            }
            Returns: {
              created_at: string
              id: string
              last_accessed_at: string
              metadata: Json
              name: string
              updated_at: string
            }[]
          }
      search_legacy_v1: {
        Args: {
          bucketname: string
          levels?: number
          limits?: number
          offsets?: number
          prefix: string
          search?: string
          sortcolumn?: string
          sortorder?: string
        }
        Returns: {
          created_at: string
          id: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      search_v1_optimised: {
        Args: {
          bucketname: string
          levels?: number
          limits?: number
          offsets?: number
          prefix: string
          search?: string
          sortcolumn?: string
          sortorder?: string
        }
        Returns: {
          created_at: string
          id: string
          last_accessed_at: string
          metadata: Json
          name: string
          updated_at: string
        }[]
      }
      search_v2:
        | {
            Args: {
              bucket_name: string
              levels?: number
              limits?: number
              prefix: string
              start_after?: string
            }
            Returns: {
              created_at: string
              id: string
              key: string
              metadata: Json
              name: string
              updated_at: string
            }[]
          }
        | {
            Args: {
              bucket_name: string
              levels?: number
              limits?: number
              prefix: string
              sort_column?: string
              sort_column_after?: string
              sort_order?: string
              start_after?: string
            }
            Returns: {
              created_at: string
              id: string
              key: string
              last_accessed_at: string
              metadata: Json
              name: string
              updated_at: string
            }[]
          }
    }
    Enums: {
      buckettype: "STANDARD" | "ANALYTICS" | "VECTOR"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_permission: [
        "app.read",
        "app.insert",
        "app.update",
        "app.delete",
        "profile.read",
        "profile.insert",
        "profile.update",
        "profile.delete",
        "api_key.read",
        "api_key.insert",
        "api_key.update",
        "api_key.delete",
        "tenant.read",
        "tenant.update",
        "billing.read",
        "billing.update",
        "billing.insert",
        "git_connection.read",
        "git_connection.insert",
        "git_connection.update",
        "git_connection.delete",
        "git_branch.read",
        "git_branch.insert",
        "git_branch.update",
        "git_branch.delete",
        "dashboard.read",
        "dashboard.insert",
        "dashboard.update",
        "dashboard.delete",
        "app_member_role.read",
        "app_member_role.insert",
        "app_member_role.update",
        "app_member_role.delete",
        "sso_config.read",
        "sso_config.insert",
        "sso_config.update",
        "sso_config.delete",
        "custom_role.read",
        "custom_role.insert",
        "custom_role.update",
        "custom_role.delete",
        "trace.read",
        "experiment.read",
        "env_var.read",
        "env_var.insert",
        "env_var.update",
        "env_var.delete",
        "trace.write",
        "score.read",
        "score.write",
        "score.delete",
        "span.read",
        "session.read",
        "metrics.read",
        "environment.read",
        "environment.insert",
        "environment.update",
        "environment.delete",
        "environment.promote",
        "app_policy.update",
        "audit_log.read",
        "context.read",
        "context.insert",
        "context.update",
        "context.delete",
        "agents.sessions.self.read",
        "agents.sessions.team.read",
        "agents.settings.write",
        "worker_run.read",
        "worker_run.insert",
        "worker_run.update",
        "worker_run.delete",
        "ai_cost_config.read",
        "ai_cost_config.insert",
        "ai_cost_config.update",
        "ai_cost_config.delete",
        "membership.read",
        "membership.insert",
        "membership.update",
        "membership.delete",
      ],
      app_role: ["admin", "write", "read", "disabled", "owner"],
      flag_strategy: ["global", "random", "targeted", "percentage"],
      platform_permission: [
        "platform.org.read",
        "platform.org.delete",
        "platform.user.read",
        "platform.user.delete",
        "platform.temp_access.grant",
        "platform.flag.manage",
        "platform.audit.read",
        "platform.changelog.read",
        "platform.changelog.write",
        "platform.changelog.delete",
        "platform.entitlement.read",
        "platform.entitlement.write",
        "platform.entitlement.delete",
        "platform.dora.read",
        "platform.alert_agent_config.read",
        "platform.alert_agent_config.write",
        "platform.alert_agent_config.update",
        "platform.alert_agent_config.delete",
        "platform.alert_agent_run.read",
        "platform.alert_agent_run.write",
        "platform.sso_config.read",
        "platform.environment.read",
        "platform.promotion.intervene",
      ],
      platform_role: ["platform_admin"],
    },
  },
  storage: {
    Enums: {
      buckettype: ["STANDARD", "ANALYTICS", "VECTOR"],
    },
  },
} as const

