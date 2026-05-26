export type GameOption = {
  id: string;
  name: string;
  note: string;
  steamAppId: number | null;
  coverUrl: string;
  storeUrl: string;
  releaseDate: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  tags: string[];
};

export type Vote = {
  voterId: string;
  name: string;
  choiceId: string;
  rankedChoiceIds: string[];
  installedOptionIds: string[];
  isReady: boolean;
  updatedAt: string;
};

export type ActivePoll = {
  id: string;
  title: string;
  createdAt: string;
  endsAt: string | null;
  options: GameOption[];
  votes: Record<string, Vote>;
};

export type ResultOption = GameOption & {
  votes: number;
  firstPlaceVotes: number;
  readyVotes: number;
  percent: number;
  readyPercent: number;
  voters: Array<{
    name: string;
    isReady: boolean;
    isInstalled: boolean;
    rank: number;
  }>;
};

export type PollResults = {
  pollId: string;
  title: string;
  createdAt: string;
  totalVotes: number;
  options: ResultOption[];
};

export type Winner = {
  id: string;
  name: string;
  votes: number;
};

export type HistoryEntry = {
  pollId: string;
  title: string;
  createdAt: string;
  closedAt: string;
  totalVotes: number;
  winners: Winner[];
  results: ResultOption[];
};

export type PoolGame = {
  id: string;
  name: string;
  note: string;
  steamAppId: number | null;
  coverUrl: string;
  storeUrl: string;
  releaseDate: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  tags: string[];
  createdAt: string;
};

export type PollTemplate = {
  id: string;
  name: string;
  title: string;
  durationMinutes: number;
  games: GameDraftSnapshot[];
  createdAt: string;
  updatedAt: string;
};

export type GameDraftSnapshot = {
  name: string;
  note: string;
  steamAppId: number | null;
  coverUrl: string;
  storeUrl: string;
  releaseDate: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  tags: string[];
};

export type OnboardingSettings = {
  enabled: boolean;
  title: string;
  wlanInfo: string;
  voiceInfo: string;
  foodInfo: string;
  scheduleInfo: string;
  helpInfo: string;
  sections: OnboardingSection[];
  categoryOrder: string[];
};

export type OnboardingSection = {
  id: string;
  title: string;
  content: string;
};

export type AppSettings = {
  participantPollsEnabled: boolean;
};

export type SteamGameDetails = {
  appid: number;
  name: string;
  coverUrl: string;
  storeUrl: string;
  shortDescription: string;
  genres: string[];
  categories: string[];
  tags: string[];
  minPlayers: number | null;
  maxPlayers: number | null;
  releaseDate: string;
};

export type PublicState = {
  activePoll: ActivePoll | null;
  activeResults: PollResults | null;
  history: HistoryEntry[];
  onboarding: OnboardingSettings;
  settings: AppSettings;
  server: {
    lanAddress: string;
    port: number;
    publicUrl: string;
    monitorUrl: string;
    onboardingUrl: string;
    qrUrl: string;
    voteUrl: string;
    adminUrl: string;
    tvUrl: string;
  };
};
