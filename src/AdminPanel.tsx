import React, { useState, useEffect } from 'react';
import { collection, getDocs, setDoc, doc, serverTimestamp, deleteDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { Loader2, Plus, X, Copy, CheckCircle2, Search, Trash2 } from 'lucide-react';

export default function AdminPanel({ onClose }: { onClose: () => void }) {
  const [codes, setCodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadCodes = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'invitation_codes'));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      const usersSnap = await getDocs(collection(db, 'users'));
      const usersData: Record<string, string> = {};
      usersSnap.docs.forEach(d => {
        usersData[d.id] = d.data().email;
      });

      data.sort((a, b) => {
        const timeA = a.createdAt ? a.createdAt.seconds : 0;
        const timeB = b.createdAt ? b.createdAt.seconds : 0;
        return timeB - timeA;
      });
      
      const enrichedData = data.map(c => ({
        ...c,
        usedByEmail: c.usedByEmail || usersData[c.usedBy] || null
      }));
      
      setCodes(enrichedData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCodes();
  }, []);

  const [bulkCount, setBulkCount] = useState(1);

  const generateCode = async () => {
    setGenerating(true);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    try {
      if (bulkCount > 1) {
        // Bulk generation uses batch for better performance
        const batch = writeBatch(db);
        let count = Math.min(bulkCount, 500); // 500 limit per batch
        for (let j = 0; j < count; j++) {
          let newCode = '';
          for (let i = 0; i < 28; i++) {
              newCode += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          batch.set(doc(db, 'invitation_codes', newCode), {
            code: newCode,
            isUsed: false,
            createdBy: 'skywings38@gmail.com',
            createdAt: serverTimestamp()
          });
        }
        await batch.commit();
      } else {
        let newCode = '';
        for (let i = 0; i < 28; i++) {
            newCode += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        await setDoc(doc(db, 'invitation_codes', newCode), {
          code: newCode,
          isUsed: false,
          createdBy: 'skywings38@gmail.com',
          createdAt: serverTimestamp()
        });
      }
      await loadCodes();
      setBulkCount(1);
    } catch (err: any) {
      console.error(err);
      setErrorMsg('생성에 실패했습니다: ' + err.message);
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(code);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDeleteCode = async (codeId: string) => {
    if (confirmDeleteId !== codeId) {
      setConfirmDeleteId(codeId);
      return;
    }
    try {
      await deleteDoc(doc(db, 'invitation_codes', codeId));
      await loadCodes();
    } catch (err: any) {
      console.error("Delete error", err);
      setErrorMsg('삭제에 실패했습니다: ' + err.message);
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const filteredCodes = codes.filter(c => {
    const q = searchQuery.toLowerCase();
    return c.code.toLowerCase().includes(q) || 
           (c.usedByEmail && c.usedByEmail.toLowerCase().includes(q)) ||
           (c.usedBy && c.usedBy.toLowerCase().includes(q));
  });

  const totalCount = codes.length;
  const usedCount = codes.filter(c => c.isUsed).length;
  const unusedCount = totalCount - usedCount;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 font-sans text-text">
      <div className="bg-surface border border-accent/20 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col relative overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold">초대 코드 관리 (관리자)</h2>
          <button 
            onClick={onClose}
            className="p-2 -mr-2 text-text-dim hover:text-text rounded-lg hover:bg-border/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-auto bg-background/50 flex flex-col">
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="font-medium text-text">발급된 코드 목록 (총 {totalCount}개)</h3>
              <p className="text-sm text-text-dim">사용됨: {usedCount} / 미사용: {unusedCount}</p>
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <div className="flex items-center bg-surface border border-border rounded-lg px-3 py-2 shrink-0 h-10">
                <span className="text-xs text-text-dim mr-2">발급 수</span>
                <input 
                  type="number" 
                  min="1" 
                  max="500" 
                  value={bulkCount}
                  onChange={(e) => setBulkCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
                  className="w-12 bg-transparent text-text outline-none text-right font-mono text-sm"
                />
              </div>
              <button
                onClick={generateCode}
                disabled={generating}
                className="flex items-center justify-center gap-2 px-4 h-10 bg-accent text-background font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 tracking-wide whitespace-nowrap flex-1 sm:flex-none"
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                코드 생성
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm flex items-center justify-between">
              <span>{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} className="p-1 hover:text-red-300">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="mb-4 relative shrink-0">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" />
            <input 
              type="text" 
              placeholder="코드 또는 이메일로 검색..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all text-text"
            />
          </div>

          <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-1">
            {loading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-text-dim" />
              </div>
            ) : filteredCodes.length === 0 ? (
              <div className="text-center py-12 bg-surface border border-border rounded-lg text-text-dim">
                검색된 코드가 없습니다.
              </div>
            ) : (
              filteredCodes.map(c => (
                <div key={c.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-surface border border-border rounded-lg gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <span className="font-mono text-sm sm:text-base tracking-wide text-text break-all max-w-[200px] sm:max-w-none">{c.code}</span>
                      <button 
                        onClick={() => copyCode(c.code)}
                        className="text-text-dim hover:text-accent transition-colors p-1"
                        title="코드 복사"
                      >
                        {copiedId === c.code ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      {c.isUsed ? (
                        <span className="inline-flex px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                          사용됨
                        </span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                          미사용
                        </span>
                      )}
                      
                      {c.usedBy && (
                        <span className="text-text-dim" title={`UID: ${c.usedBy}`}>
                          {c.usedByEmail ? `사용자: ${c.usedByEmail}` : `사용자 UID: ${c.usedBy.slice(0, 8)}...`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end mt-2 sm:mt-0">
                    {!c.isUsed && (
                      <div className="flex items-center gap-2">
                        {confirmDeleteId === c.id && (
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-text-dim hover:text-text px-3 py-1.5 rounded-lg text-sm transition-colors"
                          >
                            취소
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteCode(c.id)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm ${
                            confirmDeleteId === c.id 
                              ? 'bg-red-500 text-white hover:bg-red-600' 
                              : 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
                          }`}
                          title="코드 삭제"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span className={confirmDeleteId === c.id ? '' : 'sm:hidden'}>
                            {confirmDeleteId === c.id ? '삭제 확인' : '삭제'}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
