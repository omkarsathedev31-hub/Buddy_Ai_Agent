import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PublicUser, SupportedLanguage, UserSettings } from '../../shared/types.ts';
import { apiRequest, setAuthToken } from '../lib/api.ts';

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

export interface AdminSetupStatus {
  hasEnvPasscode: boolean;
  hasClaimedPasscode: boolean;
  hasAdminUser: boolean;
}

interface AppContextValue {
  user: PublicUser | null;
  settings: UserSettings | null;
  adminSetup: AdminSetupStatus;
  loading: boolean;
  guestLanguage: SupportedLanguage;
  setGuestLanguage: (lang: SupportedLanguage) => void;
  notifications: NotificationItem[];
  unreadCount: number;
  refreshSession: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  setAuthData: (user: PublicUser, settings: UserSettings, token?: string) => void;
  updateSettings: (patch: Partial<UserSettings> & { name?: string; phone?: string; language?: SupportedLanguage }) => Promise<void>;
  logout: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [adminSetup, setAdminSetup] = useState<AdminSetupStatus>({
    hasEnvPasscode: false,
    hasClaimedPasscode: false,
    hasAdminUser: false,
  });
  const [guestLanguage, setGuestLanguage] = useState<SupportedLanguage>('en');
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshNotifications = useCallback(async () => {
    try {
      const data = await apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications');
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore if unauthenticated
    }
  }, []);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{
        authenticated: boolean;
        user: PublicUser | null;
        settings: UserSettings | null;
        adminSetup: AdminSetupStatus;
      }>('/api/auth/session');
      setAdminSetup(res.adminSetup);
      if (res.authenticated && res.user && res.settings) {
        setUser(res.user);
        setSettings(res.settings);
        setGuestLanguage(res.user.language);
      } else {
        setAuthToken(null);
        setUser(null);
        setSettings(null);
      }
    } catch {
      setAuthToken(null);
      setUser(null);
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (user) {
      void refreshNotifications();
    } else {
      setNotifications([]);
      setUnreadCount(0);
    }
  }, [user, refreshNotifications]);

  // Apply global accessibility & theme classes to <html>
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove('text-scale-sm', 'text-scale-normal', 'text-scale-lg', 'text-scale-xl', 'dark');
    const scale = settings?.text_size ?? 'normal';
    html.classList.add(`text-scale-${scale}`);
    if (settings?.theme === 'dark') {
      html.classList.add('dark');
    }
    html.setAttribute('data-contrast', settings?.contrast_mode ?? 'standard');
    html.setAttribute('data-reduced-motion', settings?.reduced_motion ? 'true' : 'false');
  }, [settings]);

  const setAuthData = useCallback((nextUser: PublicUser, nextSettings: UserSettings, token?: string) => {
    if (token) {
      setAuthToken(token);
    }
    setUser(nextUser);
    setSettings(nextSettings);
    setGuestLanguage(nextUser.language);
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<UserSettings> & { name?: string; phone?: string; language?: SupportedLanguage }) => {
      const res = await apiRequest<{ user: PublicUser; settings: UserSettings }>('/api/settings', {
        method: 'PUT',
        body: patch,
      });
      setUser(res.user);
      setSettings(res.settings);
      setGuestLanguage(res.user.language);
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // clear local state even if session already expired
    }
    setAuthToken(null);
    setUser(null);
    setSettings(null);
    setNotifications([]);
    setUnreadCount(0);
  }, []);

  const markNotificationRead = useCallback(async (id: string) => {
    await apiRequest(`/api/notifications/${id}/read`, { method: 'POST' });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
  }, []);

  const markAllNotificationsRead = useCallback(async () => {
    await apiRequest('/api/notifications/read-all', { method: 'POST' });
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
  }, []);

  return (
    <AppContext.Provider
      value={{
        user,
        settings,
        adminSetup,
        loading,
        guestLanguage,
        setGuestLanguage,
        notifications,
        unreadCount,
        refreshSession,
        refreshNotifications,
        markNotificationRead,
        markAllNotificationsRead,
        setAuthData,
        updateSettings,
        logout,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
