import React, { useState } from 'react';
import { User, signOut } from 'firebase/auth';
import { doc, getDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase';
import { Loader2, KeyRound } from 'lucide-react';

export default function Activation({ user, onActivated }: { user: User, onActivated: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 28) {
      setError('초대 코드는 28자리입니다.');
      return;
    }
    
    setLoading(true);
    setError('');
    
    try {
      const codeRef = doc(db, 'invitation_codes', code.toUpperCase());
      const codeDoc = await getDoc(codeRef);
      
      if (!codeDoc.exists()) {
        setError('유효하지 않은 코드입니다.');
        setLoading(false);
        return;
      }
      
      if (codeDoc.data().isUsed) {
        setError('이미 사용된 코드입니다.');
        setLoading(false);
        return;
      }
      
      const batch = writeBatch(db);
      
      const userRef = doc(db, 'users', user.uid);
      batch.update(userRef, {
        isActivated: true,
        invitationCode: code.toUpperCase(),
        updatedAt: serverTimestamp()
      });
      
      batch.update(codeRef, {
        isUsed: true,
        usedBy: user.uid,
        usedByEmail: user.email,
        updatedAt: serverTimestamp()
      });
      
      await batch.commit();
      onActivated();
    } catch (err: any) {
      console.error(err);
      setError('활성화 처리 중 오류가 발생했습니다. (' + err.message + ')');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-text font-sans">
      <div className="w-full max-w-md p-8 space-y-8 bg-surface border border-accent/20 rounded-xl shadow-2xl relative overflow-hidden">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-accent/30 bg-accent/10 mb-4">
            <KeyRound className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">서비스 접근 권한 필요</h1>
          <p className="text-sm text-text-dim">
            이 서비스는 초대 코드를 구매한 분들만 이용할 수 있습니다.<br />
            28자리 코드를 입력해주세요.
          </p>
        </div>

        {error && (
          <div className="p-3 text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded">
            {error}
          </div>
        )}

        <form onSubmit={handleActivate} className="space-y-6">
          <div className="space-y-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              maxLength={28}
              className="w-full px-4 py-3 bg-background border border-border rounded-lg focus:border-accent focus:ring-1 focus:ring-accent outline-none text-text text-center text-sm sm:text-base tracking-widest font-mono transition-all"
              placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              disabled={loading}
            />
            <div className="flex justify-between text-xs text-text-dim px-1">
              <span>예: A1B2C3D4E5F6G7H8I9J0K1L2M3N4</span>
              <span>{code.length}/28</span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || code.length !== 28}
            className="w-full py-3 bg-accent text-background font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : '접근 권한 활성화'}
          </button>
        </form>

        <div className="pt-4 border-t border-border flex justify-between items-center text-sm">
          <span className="text-text-dim">{user.email} 계정</span>
          <button 
            onClick={() => signOut(auth)}
            className="text-text hover:text-red-400 transition-colors"
          >
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}
