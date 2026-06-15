import React, { useState, useEffect } from 'react';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  sendPasswordResetEmail,
  User
} from 'firebase/auth';
import { auth, googleProvider } from './firebase';

export default function Auth({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  useEffect(() => {
    // Handle redirect result if coming back from redirect sign-in
    getRedirectResult(auth).then((result) => {
      if (result?.user) {
        // User is signed in
        onAuthenticated(result.user);
      }
    }).catch((err) => {
      console.error(err);
      if (err.code !== 'auth/redirect-cancelled-by-user') {
        setError(err.message || '구글 로그인 중 오류가 발생했습니다.');
      }
    });
  }, [onAuthenticated]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetMessage('');
    
    if (!email) {
      setError('이메일을 입력해주세요.');
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      setResetMessage('비밀번호 재설정 이메일이 전송되었습니다. 이메일함을 확인해주세요.');
    } catch (err: any) {
      setError(err.message || '비밀번호 재설정 이메일 전송에 실패했습니다.');
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력해주세요.');
      return;
    }

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setError(err.message || '인증에 실패했습니다.');
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      if (err.code === 'auth/popup-blocked') {
        setError('팝업이 차단되었습니다. 브라우저 설정에서 팝업을 허용해주세요. (인앱 브라우저인 경우 사파리나 크롬으로 열어주세요)');
      } else {
        setError(err.message || '구글 로그인에 실패했습니다.');
      }
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-text font-sans">
      <div className="w-full max-w-md p-8 space-y-6 bg-surface border border-accent/20 rounded-xl shadow-2xl relative overflow-hidden">
        {/* Subtle glow effect behind card */}
        <div className="absolute inset-0 bg-accent/5 blur-3xl rounded-xl -z-10" />
        
        <h1 className="text-3xl font-bold text-center tracking-tight text-text">
          {isResettingPassword ? '비밀번호 찾기' : (isLogin ? '로그인' : '회원가입')}
        </h1>
        
        {error && (
          <div className="p-3 text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded">
            {error}
          </div>
        )}

        {resetMessage && (
          <div className="p-3 text-sm text-green-500 bg-green-500/10 border border-green-500/20 rounded">
            {resetMessage}
          </div>
        )}

        {isResettingPassword ? (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-dim">가입한 이메일</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded focus:border-accent focus:ring-1 focus:ring-accent outline-none text-text transition-all"
                placeholder="name@example.com"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 bg-accent text-background font-medium rounded hover:opacity-90 transition-opacity"
            >
              재설정 링크 받기
            </button>
            <button
              type="button"
              onClick={() => { setIsResettingPassword(false); setError(''); setResetMessage(''); }}
              className="w-full py-2.5 bg-transparent border border-border text-text font-medium rounded hover:bg-border/50 transition-colors"
            >
              로그인으로 돌아가기
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={handleEmailAuth} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-dim">이메일</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:border-accent focus:ring-1 focus:ring-accent outline-none text-text transition-all"
                  placeholder="name@example.com"
                />
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-text-dim">비밀번호</label>
                  {isLogin && (
                    <button
                      type="button"
                      onClick={() => { setIsResettingPassword(true); setError(''); setResetMessage(''); }}
                      className="text-xs text-accent hover:underline focus:outline-none"
                    >
                      비밀번호를 잊으셨나요?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded focus:border-accent focus:ring-1 focus:ring-accent outline-none text-text transition-all"
                  placeholder="••••••••"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-accent text-background font-medium rounded hover:opacity-90 transition-opacity"
              >
                {isLogin ? '로그인' : '가입하기'}
              </button>
            </form>

            <div className="relative mt-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-surface text-text-dim">또는</span>
              </div>
            </div>

            <button
              onClick={handleGoogleLogin}
              type="button"
              className="w-full mt-4 py-2.5 bg-background border border-border text-text font-medium rounded hover:bg-border/50 transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                <path d="M1 1h22v22H1z" fill="none"/>
              </svg>
              Google로 {isLogin ? '로그인' : '시작하기'}
            </button>

            <p className="text-center text-sm text-text-dim mt-4">
              {isLogin ? '계정이 없으신가요?' : '이미 계정이 있으신가요?'}
              <button
                onClick={() => setIsLogin(!isLogin)}
                className="ml-2 font-medium text-accent hover:underline focus:outline-none"
              >
                {isLogin ? '회원가입' : '로그인'}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
